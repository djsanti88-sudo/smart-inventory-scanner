import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "../../instrumentation";

const temporaryRoots: string[] = [];

function createProject(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "scanbin-client-egress-"));
  temporaryRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, "src", relativePath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

function findLiteralExternalClientEgress(sourceRoot: string): string[] {
  const sourceDirectory = resolve(sourceRoot, "src");
  const extensions = [".ts", ".tsx", ".js", ".jsx"];
  const resolveImport = (fromFile: string, specifier: string) => {
    const base = specifier.startsWith("@/")
      ? join(sourceDirectory, specifier.slice(2))
      : specifier.startsWith(".")
        ? resolve(fromFile, "..", specifier)
        : null;
    if (!base) return null;
    for (const candidate of [base, ...extensions.map((extension) => `${base}${extension}`), ...extensions.map((extension) => join(base, `index${extension}`))]) {
      if (ts.sys.fileExists(candidate) && resolve(candidate).startsWith(`${sourceDirectory}\\`)) return resolve(candidate);
    }
    return null;
  };
  const isLoopback = (hostname: string) => hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
  const isExternalLiteral = (text: string) => {
    try {
      const url = new URL(text);
      return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !isLoopback(url.hostname);
    } catch {
      return false;
    }
  };
  const entries = ts.sys.readDirectory(sourceDirectory, extensions).filter((file) => {
    const parsed = ts.createSourceFile(file, ts.sys.readFile(file) ?? "", ts.ScriptTarget.Latest, false);
    return parsed.statements.some((statement) => ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression) && statement.expression.text === "use client");
  });
  const visited = new Set<string>();
  const findings: string[] = [];
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(file, ts.sys.readFile(file) ?? "", ts.ScriptTarget.Latest, true);
    const inspect = (node: ts.Node) => {
      const isFetch = ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch";
      const isStream = ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ["WebSocket", "EventSource"].includes(node.expression.text);
      if ((isFetch || isStream) && node.arguments?.[0] && ts.isStringLiteral(node.arguments[0]) && isExternalLiteral(node.arguments[0].text)) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        const kind = ts.isIdentifier(node.expression) ? node.expression.text : "unknown";
        findings.push(`${relative(sourceDirectory, file).replaceAll("\\", "/")}:${position.line + 1} ${kind} ${node.arguments[0].text}`);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const imported = resolveImport(file, statement.moduleSpecifier.text);
      if (imported) visit(imported);
    }
  };
  entries.forEach(visit);
  return findings.sort();
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe("local demo client egress scanner", () => {
  it("leaves instrumentation inert outside local demo", () => {
    vi.stubEnv("SCANBIN_LOCAL_DEMO", "");
    expect(() => register()).not.toThrow();
  });

  it("rejects direct client literal fetch, WebSocket, and EventSource egress", () => {
    const root = createProject({
      "app/page.tsx": '"use client"; fetch("https://example.com"); new WebSocket("wss://example.com"); new EventSource("http://example.com");',
    });
    expect(findLiteralExternalClientEgress(root)).toHaveLength(3);
  });

  it("rejects literal external egress in imported client descendants and terminates cycles", () => {
    const root = createProject({
      "app/page.tsx": '"use client"; import "@/components/one";',
      "components/one.ts": 'import "./two";',
      "components/two.ts": 'import "./one"; fetch("https://example.com/descendant");',
    });
    expect(findLiteralExternalClientEgress(root)).toEqual(["components/two.ts:1 fetch https://example.com/descendant"]);
  });

  it("allows loopback literals and has no broad allowlist escape", () => {
    const root = createProject({
      "app/page.tsx": '"use client"; fetch("http://127.0.0.1:3000"); new WebSocket("ws://localhost:3000");',
    });
    expect(findLiteralExternalClientEgress(root)).toEqual([]);
  });

  // This intentionally narrow static defense detects only direct literal URL calls in client-reachable TS/JS.
  // Dynamic URLs, indirect wrappers, SDKs, CSS, and DOM resource loading require separate runtime controls.
  it("finds no direct literal external egress in the actual client-reachable source graph", () => {
    expect(findLiteralExternalClientEgress(process.cwd())).toEqual([]);
  });
});
