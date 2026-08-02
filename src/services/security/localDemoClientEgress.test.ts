import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "../../instrumentation";

const temporaryRoots: string[] = [];

type PathShape = Pick<typeof posix, "isAbsolute" | "relative" | "sep">;

function isPathWithin(sourceDirectory: string, candidate: string, pathShape: PathShape = { isAbsolute, relative, sep }) {
  const relativePath = pathShape.relative(sourceDirectory, candidate);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${pathShape.sep}`) &&
    !pathShape.isAbsolute(relativePath)
  );
}

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
      if (ts.sys.fileExists(candidate) && isPathWithin(sourceDirectory, resolve(candidate))) return resolve(candidate);
    }
    return null;
  };
  const isLoopback = (hostname: string) => {
    if (hostname === "localhost" || hostname === "::1") return true;
    const octets = hostname.split(".");
    return octets.length === 4 &&
      octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
      Number(octets[0]) === 127;
  };
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

  it("rejects direct client literal fetch, WebSocket, and EventSource egress across http, https, ws, and wss", () => {
    const root = createProject({
      "app/page.tsx": '"use client"; fetch("https://example.com/https"); fetch("http://example.com/http"); new WebSocket("wss://example.com/wss"); new WebSocket("ws://example.com/ws"); new EventSource("https://example.com/events");',
    });
    const findings = findLiteralExternalClientEgress(root);
    expect(findings).toHaveLength(5);
    for (const url of [
      "https://example.com/https",
      "http://example.com/http",
      "wss://example.com/wss",
      "ws://example.com/ws",
    ]) {
      expect(findings.some((finding) => finding.endsWith(url))).toBe(true);
    }
  });

  it("treats Linux-shaped descendants as contained without accepting traversal or absolute escapes", () => {
    expect(isPathWithin("/repo/src", "/repo/src/components/client.ts", posix)).toBe(true);
    expect(isPathWithin("/repo/src", "/repo/src-escape/client.ts", posix)).toBe(false);
    expect(isPathWithin("/repo/src", "/repo/outside/client.ts", posix)).toBe(false);
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

  it("rejects hostnames that merely begin with the 127 label", () => {
    const root = createProject({
      "app/page.tsx": '"use client"; fetch("https://127.example.com/not-loopback");',
    });
    expect(findLiteralExternalClientEgress(root)).toEqual([
      "app/page.tsx:1 fetch https://127.example.com/not-loopback",
    ]);
  });

  // This intentionally narrow static defense detects only direct literal URL calls in client-reachable TS/JS.
  // Dynamic URLs, indirect wrappers, SDKs, CSS, and DOM resource loading require separate runtime controls.
  it("finds no direct literal external egress in the actual client-reachable source graph", () => {
    expect(findLiteralExternalClientEgress(process.cwd())).toEqual([]);
  });
});
