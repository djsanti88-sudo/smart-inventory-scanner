import "server-only";

import { assertLocalDemoDatabase } from "../../scripts/local-demo-preflight.mjs";

type LocalDemoDatabasePreflight = ReturnType<typeof assertLocalDemoDatabase>;

export function getLocalDemoDatabasePreflight(): LocalDemoDatabasePreflight {
  return assertLocalDemoDatabase();
}
