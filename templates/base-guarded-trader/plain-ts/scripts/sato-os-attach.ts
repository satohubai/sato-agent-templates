// npm run sato-os:attach -- --url <your Sato OS> --wallet <0x…> [--name …] [--goal …] [--chains Base] [--dir .sato] [--overwrite]
//
// Attaches this agent to your self-hosted Sato OS and stores the agent's
// scoped token in .sato/sato-os.json (mode 0600, gitignored). The token is
// never printed. After this, `npm start -- --mode sato-os` hands allowed
// intents to Sato OS as proposals instead of signing anything here.

import { AttachUsageError, parseAttachArgs, runAttach } from "../src/sato-os.js";

async function main(): Promise<number> {
  const args = parseAttachArgs(process.argv.slice(2), process.env);
  const r = await runAttach(args);
  console.log(`Attached to Sato OS at ${args.url}`);
  console.log(`  agent      ${r.agent_id}${r.agent_slug ? ` (${r.agent_slug})` : ""}`);
  console.log(`  open it at ${args.url.replace(/\/+$/, "")}${r.open_at}`);
  console.log(`  token      stored in ${r.config_path} (not printed)`);
  console.log("\nNext: npm start -- --mode sato-os");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`\nStopped: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(e instanceof AttachUsageError ? 2 : 1);
  },
);
