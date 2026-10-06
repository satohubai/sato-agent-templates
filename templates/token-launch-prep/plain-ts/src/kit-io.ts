// The ONE place this template names kit action ids and their input shapes.
// They mirror the input_schema tx.simulate publishes in @satohub/kit 0.1.1
// (`kit.describe("tx.simulate").input_schema`). The kit validates every input
// itself; if a shape drifts, its ActionInputError names the field.

import type { LaunchChain } from "./clanker.js";

export const ACTIONS = {
  txSimulate: "tx.simulate",
} as const;

export type TxSimulateInput = {
  chain: LaunchChain;
  from: string;
  to: string;
  data: string;
  /** Wei as a decimal string. */
  value: string;
};

/** tx.simulate output (the kit's SimulationResult). */
export type TxSimulateOutput = {
  ok: boolean;
  method: string;
  block: string | null;
  gas_estimate: string | null;
  error: string | null;
  as_of: string;
};
