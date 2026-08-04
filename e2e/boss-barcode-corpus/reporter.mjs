import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createReceipt } from "./receipt.mjs";

export default class LocalCorpusReporter {
  onBegin(_config, suite) { this.startedAt = Date.now(); this.total = suite.allTests().length; this.results = []; }
  onTestEnd(_test, result) { this.results.push(result); }
  onEnd(result) {
    const attachments = this.results.flatMap((entry) => entry.attachments ?? []).filter((entry) => entry.name === "local-corpus-summary");
    const payload = attachments.length === 1 && attachments[0].body ? JSON.parse(Buffer.from(attachments[0].body).toString("utf8")) : null;
    const status = result.status === "passed" && payload ? "passed" : "failed";
    const receipt = createReceipt({ status, testsExpected: this.total, testsObserved: this.results.length, elapsedMs: Date.now() - this.startedAt, aggregate: payload, failures: this.results.filter((entry) => entry.status !== "passed").map((entry) => ({ status: entry.status })) });
    const dir = resolve("outputs/boss-barcode-certification"); mkdirSync(dir, { recursive: true });
    const target = resolve(dir, "localhost-synthetic-ui.receipt.json"); const temporary = resolve(dir, `.local-${process.pid}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" }); renameSync(temporary, target);
  }
}
