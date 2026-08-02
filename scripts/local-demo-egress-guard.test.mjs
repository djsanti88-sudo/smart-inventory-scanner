import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const guard = resolve("scripts/local-demo-egress-guard.cjs");

function guarded(code, ledger, extra = []) {
  return spawnSync(process.execPath, [...extra, "-e", code], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${guard}`,
      SCANBIN_LOCAL_DEMO: "1",
      SCANBIN_LOCAL_DEMO_EGRESS_LEDGER: ledger,
    },
  });
}

test("preloaded guard blocks external transports, sanitizes the ledger, and covers later ESM imports", () => {
  const directory = mkdtempSync(join(tmpdir(), "scanbin-egress-"));
  const ledger = join(directory, "ledger.jsonl");
  try {
    const script = `
      const attempts = [];
      const capture = (name, fn) => { try { const value = fn(); if (value?.catch) value.catch(() => {}); }
        catch (error) { attempts.push(name + ":" + error.code); } };
      capture("http", () => require("node:http").get("http://example.com/a?secret=1"));
      capture("http-host-port", () => require("node:http").get({ host: "example.com:8080", path: "/b?secret=2" }));
      capture("http-client-request", () => {
        const http = require("node:http");
        const agent = new http.Agent();
        agent.createConnection = () => { const error = new Error("bypass"); error.code = "BYPASS"; throw error; };
        return new http.ClientRequest({ host: "example.com", path: "/direct", agent });
      });
      capture("https", () => require("node:https").get("https://example.com/a?secret=1"));
      capture("http2", () => require("node:http2").connect("https://example.com"));
      capture("net", () => require("node:net").connect(443, "example.com"));
      capture("net-prototype", () => new (require("node:net").Socket)().connect(443, "example.com"));
      capture("tls", () => require("node:tls").connect(443, "example.com"));
      capture("dns", () => require("node:dns").lookup("example.com", () => {}));
      capture("dns-resolver", () => {
        const dns = require("node:dns");
        const resolver = new dns.Resolver();
        resolver.setServers(["127.0.0.1:9"]);
        return resolver.resolve4("example.com", () => {});
      });
      capture("dgram", () => require("node:dgram").createSocket("udp4").connect(53, "8.8.8.8"));
      capture("dgram-offset", () => require("node:dgram").createSocket("udp4")
        .send(Buffer.from("hello"), 0, 5, 53, "8.8.4.4"));
      capture("websocket", () => globalThis.WebSocket ? new WebSocket("wss://example.com/private?token=x") : null);
      Promise.resolve(fetch("https://example.com/private?token=x")).catch((error) => {
        attempts.push("fetch:" + error.code);
        console.log(JSON.stringify(attempts));
      });
    `;
    const result = guarded(script, ledger);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /LOCAL_DEMO_EGRESS_BLOCKED/);
    const esm = guarded(
      `import("node:https").then(({request}) => { try { request("https://example.com/esm?secret=1"); }
       catch (error) { console.log(error.code); } });`,
      ledger,
      ["--input-type=module"],
    );
    assert.equal(esm.status, 0, esm.stderr);
    assert.match(esm.stdout, /LOCAL_DEMO_EGRESS_BLOCKED/);
    const lines = readFileSync(ledger, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.ok(lines.length >= 13);
    assert.match(result.stdout, /net-prototype:LOCAL_DEMO_EGRESS_BLOCKED/);
    assert.match(result.stdout, /http-client-request:LOCAL_DEMO_EGRESS_BLOCKED/);
    assert.match(result.stdout, /dns-resolver:LOCAL_DEMO_EGRESS_BLOCKED/);
    assert.ok(lines.some((entry) => entry.protocol === "tcp:" && entry.host === "example.com"));
    assert.ok(lines.some((entry) => entry.protocol === "udp:" && entry.host === "8.8.4.4"));
    assert.ok(lines.some((entry) => entry.protocol === "http:" && entry.host === "example.com" && entry.path === "/b"));
    assert.ok(lines.every((entry) => !JSON.stringify(entry).includes("secret=1")));
    assert.ok(lines.every((entry) => !JSON.stringify(entry).includes("token=x")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a blocked attempt fails closed when its ledger cannot be written", () => {
  const directory = mkdtempSync(join(tmpdir(), "scanbin-egress-ledger-failure-"));
  try {
    const missingLedger = join(directory, "missing", "ledger.jsonl");
    const result = guarded(`
      fetch("https://example.com").catch((error) => console.log(error.code));
    `, missingLedger);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /LOCAL_DEMO_EGRESS_LEDGER_FAILED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preloaded local-demo guard attests its immutable marker before server code", () => {
  const directory = mkdtempSync(join(tmpdir(), "scanbin-egress-marker-"));
  const ledger = join(directory, "ledger.jsonl");
  try {
    const result = guarded(`
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__SCANBIN_LOCAL_DEMO_EGRESS_GUARD__");
      console.log(JSON.stringify({ value: globalThis.__SCANBIN_LOCAL_DEMO_EGRESS_GUARD__, descriptor }));
    `, ledger);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      value: 1,
      descriptor: { value: 1, writable: false, enumerable: false, configurable: false },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loopback works and a blocked spawned worker shares the parent ledger", () => {
  const directory = mkdtempSync(join(tmpdir(), "scanbin-egress-worker-"));
  const ledger = join(directory, "ledger.jsonl");
  try {
    const loopback = guarded(`
      const http = require("node:http");
      const server = http.createServer((_req, res) => res.end("ok"));
      server.listen(0, "127.0.0.1", async () => {
        const response = await fetch("http://127.0.0.1:" + server.address().port);
        console.log(await response.text());
        server.close();
      });
    `, ledger);
    assert.equal(loopback.status, 0, loopback.stderr);
    assert.match(loopback.stdout, /ok/);

    const worker = guarded(`
      const { spawnSync } = require("node:child_process");
      const child = spawnSync(process.execPath, ["-e",
        "fetch('https://example.com/worker?secret=1').catch(e=>console.log(e.code))"],
        { encoding: "utf8", env: process.env });
      console.log(child.stdout);
    `, ledger);
    assert.equal(worker.status, 0, worker.stderr);
    assert.match(worker.stdout, /LOCAL_DEMO_EGRESS_BLOCKED/);
    assert.match(readFileSync(ledger, "utf8"), /example\.com/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
