// True when the module is the script node was started with. Compares real
// paths, so a symlinked checkout (macOS /tmp, a linked project folder) still
// runs: a silent no-op here would look like a clean run.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMain(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
