// persona-agent: a character with memory, answering on Telegram and Discord,
// with a wallet through the Sato Kit.
//
//   inbound message -> retrieve memories -> the Model replies (it may quote or
//   prepare through the kit) -> reply sent -> both lines appended to memory.
//
// fixture  scripted inbound messages through fake connectors and a scripted
//          model. No network, no token, no key. Prints every reply and one
//          refused over-cap wallet intent (rule / limit / observed).
// fork     the Claude Agent SDK loop, live connectors, a wallet on a local
//          anvil fork of Base that cannot broadcast.
// testnet  as fork, on Base Sepolia with a managed CDP wallet. Signing only
//          with --allow-execute AND a person typing "yes" at the terminal.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadCharacter } from "./character.js";
import { parseArgs, parseConfig, UsageError, type Mode } from "./config.js";
import { liveConnectors } from "./connectors/index.js";
import { FakeConnector } from "./connectors/fake.js";
import type { Connector, Inbound } from "./connectors/types.js";
import { MemoryStore } from "./memory.js";
import { ScriptedModel, type Model } from "./model.js";
import { loadPolicy } from "./policy.js";
import { buildRuntime, USER_AGENT } from "./runtime.js";
import { refusalLine, Wallet, type WalletResult } from "./wallet.js";

const FIXTURES_DIR = "fixtures";

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(18)} ${value}`);
}

export type Exchange = { connector: string; chat_id: string; user: string; message: string; reply: string; memories_used: number; wallet: WalletResult[] };

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = parseConfig(JSON.parse(readFileSync(args.config, "utf8")));
  const character = loadCharacter(args.character);
  const policy = loadPolicy(args.policy);
  const mode: Mode = args.mode;
  const fixture = mode === "fixture";

  console.log(`persona-agent (${character.name}) — mode ${mode}`);
  console.log("The kit's pre-flight explains every refusal; enforcement lives in the signer.\n");
  line("max per trade", `${policy.max_usd_per_trade} USD`);
  line("max per day", `${policy.max_usd_per_day} USD`);
  line("unknown verdict", policy.unknown_verdict);
  line("user-agent", USER_AGENT);

  // Memory: fixture runs start from the shipped seed in out/, so every run is identical.
  const memoryPath = fixture ? join(args.out, "memory.jsonl") : cfg.memory_path;
  if (fixture) {
    mkdirSync(dirname(memoryPath), { recursive: true });
    rmSync(memoryPath, { force: true });
    if (existsSync(join(FIXTURES_DIR, "memory-seed.jsonl"))) copyFileSync(join(FIXTURES_DIR, "memory-seed.jsonl"), memoryPath);
  }
  const memory = new MemoryStore(memoryPath);
  line("memory", `${memoryPath} (${memory.all().length} entries)`);

  let connectors: Connector[];
  let model: Model;
  if (fixture) {
    const inbound = (JSON.parse(readFileSync(join(FIXTURES_DIR, "inbound", "messages.json"), "utf8")) as { messages: Inbound[] }).messages;
    connectors = [new FakeConnector("telegram", inbound), new FakeConnector("discord", inbound)];
    model = new ScriptedModel();
    line("connectors", "fake telegram + fake discord (scripted, no network)");
  } else {
    if (!process.env.ANTHROPIC_API_KEY) throw new UsageError("live modes need ANTHROPIC_API_KEY for the Claude Agent SDK");
    const live = liveConnectors(process.env);
    for (const n of live.notes) line("connector", n);
    if (!live.connectors.length) throw new UsageError("no connector is on: set TELEGRAM_BOT_TOKEN and/or DISCORD_BOT_TOKEN + DISCORD_CHANNEL_IDS");
    connectors = live.connectors;
    const { ClaudeModel } = await import("./claude.js");
    model = new ClaudeModel(cfg.model, cfg.max_turns);
  }
  line("model", model.name);

  const rt = await buildRuntime({ mode, policy, fixturesDir: FIXTURES_DIR, env: process.env });
  const wallet = new Wallet(rt, cfg);
  line("wallet", rt.signer ? `${rt.signer.kind} on ${rt.chain}${mode === "fork" ? " (cannot broadcast)" : ""}` : `no key — intents built for ${rt.taker}`);
  line("execute", mode === "testnet" && args.allowExecute ? "on: a person approves every signature at this terminal" : "off");

  const exchanges: Exchange[] = [];
  const now = () => new Date(rt.clock()).toISOString();
  const handle = async (c: Connector, m: Inbound) => {
    const memories = memory.retrieve(m.chat_id, m.text, cfg.memory_top_k);
    const out = await model.respond({ character, memories, message: m, wallet: (r) => wallet.run(r) });
    await c.send(m.chat_id, out.reply);
    memory.append({ at: now(), connector: m.connector, chat_id: m.chat_id, user: m.user, role: "user", text: m.text });
    memory.append({ at: now(), connector: m.connector, chat_id: m.chat_id, user: character.name, role: "agent", text: out.reply });
    exchanges.push({ connector: m.connector, chat_id: m.chat_id, user: m.user, message: m.text, reply: out.reply, memories_used: memories.length, wallet: out.wallet });
    console.log(`\n[${m.connector}] ${m.user}: ${m.text}`);
    for (const l of out.reply.split("\n")) console.log(`[${m.connector}] ${character.name}: ${l}`);
    for (const w of out.wallet) {
      if (w.request.kind === "prepare" && w.refusals) for (const r of w.refusals) console.log(`  ${refusalLine(r)}`);
      if (w.request.kind === "prepare" && w.policy_ok && w.intent_id && mode === "testnet" && args.allowExecute) {
        try {
          const receipt = await wallet.execute(w.intent_id, true);
          console.log(`  executed: ${receipt.status} ${receipt.tx_hash ?? ""}`);
        } catch (e) {
          console.log(`  not executed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  };

  if (fixture) {
    for (;;) {
      let any = false;
      for (const c of connectors) for (const m of await c.poll()) {
        any = true;
        await handle(c, m);
      }
      if (!any) break;
    }
  } else {
    for (;;) {
      for (const c of connectors) {
        try {
          for (const m of await c.poll()) await handle(c, m);
        } catch (e) {
          console.error(`  ${c.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (args.once) break;
      await new Promise((r) => setTimeout(r, cfg.poll_interval_s * 1000));
    }
  }

  const refused = exchanges.flatMap((e) => e.wallet).filter((w) => w.request.kind === "prepare" && w.policy_ok === false && (w.refusals ?? []).length > 0);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(
    join(args.out, "report.json"),
    JSON.stringify({ schema: "persona-agent.report/v1", mode, user_agent: USER_AGENT, character: character.name, model: model.name, exchanges, refused_intents: refused.length, executed: mode === "testnet" && args.allowExecute }, null, 2) + "\n",
  );
  console.log(`\nReport written to ${join(args.out, "report.json")}`);
  if (fixture && refused.length === 0) {
    console.log("\nFAIL: the over-cap wallet intent was not refused. The pre-flight is not doing its job; stopping with an error.");
    return 1;
  }
  if (fixture) console.log("\nDone. Nothing was signed, sent or spent, and no message left this machine.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`\nStopped: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(e instanceof UsageError ? 2 : 1);
  },
);
