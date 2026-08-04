import assert from "node:assert/strict";
import test from "node:test";

import { parseCertificationArgs } from "./certify-boss-barcodes.mjs";

test("parseCertificationArgs requires local-only direct proof and zero provider calls", () => {
  assert.deepEqual(parseCertificationArgs(["--target", "direct", "--max-provider-calls", "0"]), { target: "direct", maxProviderCalls: 0 });
  assert.throws(() => parseCertificationArgs(["--target", "preview", "--max-provider-calls", "0"]), /local direct/);
  assert.throws(() => parseCertificationArgs(["--target", "direct", "--max-provider-calls", "1"]), /zero provider/);
});
