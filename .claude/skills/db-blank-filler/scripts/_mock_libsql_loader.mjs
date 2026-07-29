// ESM resolution hook (node:module register()) that redirects the bare specifier "@libsql/client"
// to the local test-only mock in the same directory. Test-only; never used by the real script.
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_URL = pathToFileURL(path.join(__dirname, "_mock_libsql_partial_failure.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@libsql/client") {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
