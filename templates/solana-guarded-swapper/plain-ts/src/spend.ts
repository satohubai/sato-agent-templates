// "Spent today" for the daily cap.
//
// The kit counts USD from EXECUTED receipts. This agent never executes: it
// prepares. So the daily cap here counts what the agent has PREPARED today
// (every swap that cleared the pre-flight), whether or not you went on to sign
// it. That is deliberately the cautious reading: a prepared swap uses up the
// day's room.
//
// Live runs keep the total in .sato/ledger.json (gitignored) so it survives a
// restart; fixture runs keep it in memory. A ledger that cannot be read is
// "unknown", and unknown refuses (policy unknown_verdict).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { evaluatePreflight, type EvaluatePreflight, type PreflightFacts } from "@satohub/kit";

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class SpendLedger {
  private unreadable: string | null = null;
  private d = "";
  private total = 0;

  constructor(
    private readonly clock: () => number,
    private readonly file: string | null = null,
  ) {
    if (file && existsSync(file)) {
      try {
        const j = JSON.parse(readFileSync(file, "utf8")) as { day?: unknown; usd_prepared?: unknown };
        if (typeof j.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(j.day) || typeof j.usd_prepared !== "number" || !Number.isFinite(j.usd_prepared) || j.usd_prepared < 0) {
          throw new Error("unexpected shape");
        }
        this.d = j.day;
        this.total = j.usd_prepared;
      } catch (e) {
        this.unreadable = `${file} could not be read (${e instanceof Error ? e.message : String(e)})`;
      }
    }
  }

  private roll(): void {
    const today = day(this.clock());
    if (today !== this.d) {
      this.d = today;
      this.total = 0;
    }
  }

  /** USD prepared today, or null when the ledger file is unreadable (the pre-flight then refuses). */
  spentToday(): number | null {
    if (this.unreadable) return null;
    this.roll();
    return this.total;
  }

  /** A prepared swap whose USD value could not be found: the day's total is no longer known, so later swaps refuse. */
  markUnknown(why: string): void {
    this.unreadable = why;
  }

  problem(): string | null {
    return this.unreadable;
  }

  add(usd: number): void {
    if (this.unreadable) return;
    this.roll();
    this.total += usd;
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = join(dirname(this.file), `.ledger.${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify({ day: this.d, usd_prepared: this.total }, null, 2) + "\n");
      renameSync(tmp, this.file);
    }
  }
}

/**
 * The kit's own pre-flight, with "USD spent today" raised to the larger of what
 * the kit knows (executed receipts) and what this agent has prepared today. If
 * either is unknown the total is unknown, and the kit refuses.
 */
export function ledgerPreflight(ledger: SpendLedger): EvaluatePreflight {
  return (policy, facts: PreflightFacts) => {
    const mine = ledger.spentToday();
    const usd_spent_today = facts.usd_spent_today === null || mine === null ? null : Math.max(facts.usd_spent_today, mine);
    return evaluatePreflight(policy, { ...facts, usd_spent_today });
  };
}
