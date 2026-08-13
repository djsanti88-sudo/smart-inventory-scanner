// Narrow offline loader for the direct-cert process only: application aliases and server-only are
// resolved without changing the production import graph.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const root = resolvePath(import.meta.dirname, "..");
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: pathToFileURL(resolvePath(import.meta.dirname, "certify-boss-barcodes.server-only-stub.ts")).href, shortCircuit: true };
  if (specifier.startsWith("@/")) {
    const base = resolvePath(root, "src", specifier.slice(2));
    const file = existsSync(`${base}.ts`) ? `${base}.ts` : existsSync(`${base}.tsx`) ? `${base}.tsx` : base;
    return { url: pathToFileURL(file).href, shortCircuit: true };
  }
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      const base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      const file = existsSync(`${base}.ts`) ? `${base}.ts` : existsSync(`${base}.tsx`) ? `${base}.tsx` : null;
      if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".json")) return { format: "module", source: `export default ${await readFile(new URL(url), "utf8")};`, shortCircuit: true };
  return nextLoad(url, context);
}
