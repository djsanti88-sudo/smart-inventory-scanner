import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createReceipt } from "./receipt.mjs";

export function redactPersistenceDiagnostic(parsed) {
  const categories = Object.fromEntries(Object.entries(parsed?.queue?.errors ?? {}).map(([message, count]) => [
    /permission-denied|insufficient permissions/i.test(message) ? "permission_denied"
      : /payload_idempotency_mismatch/i.test(message) ? "payload_idempotency_mismatch"
        : /idempotency_conflict/i.test(message) ? "idempotency_conflict"
        : /invalid_|must be a valid/i.test(message) ? "validation_failure"
          : /unavailable|deadline|network|transaction/i.test(message) ? "retryable_transport_or_transaction"
            : "other_redacted_error",
    Number(count) || 0,
  ]));
  return {
    pending: String(parsed?.pending ?? "").replace(/\d{5,}/g, "[redacted]"),
    queue: { total: Number(parsed?.queue?.total) || 0, byOperation: parsed?.queue?.byOperation ?? {}, byStatus: parsed?.queue?.byStatus ?? {}, errorCategories: categories },
    consoleErrorCount: Array.isArray(parsed?.consoleErrors) ? parsed.consoleErrors.length : 0,
  };
}

export default class LocalCorpusReporter {
  onBegin(_config, suite) { this.startedAt = Date.now(); this.total = suite.allTests().length; this.results = []; }
  onTestEnd(_test, result) { this.results.push(result); }
  onEnd(result) {
    const attachments = this.results.flatMap((entry) => entry.attachments ?? []).filter((entry) => entry.name === "local-corpus-summary");
    const payload = attachments.length === 1 && attachments[0].body ? JSON.parse(Buffer.from(attachments[0].body).toString("utf8")) : null;
    const persistenceAttachments = this.results.flatMap((entry) => entry.attachments ?? []).filter((entry) => entry.name === "local-corpus-persistence-diagnostic");
    let persistenceDiagnostic = null;
    if (persistenceAttachments.length === 1) {
      try {
        const attachment = persistenceAttachments[0];
        const raw = attachment.body ?? (attachment.path ? readFileSync(attachment.path) : null);
        const parsed = raw ? JSON.parse(Buffer.from(raw).toString("utf8")) : null;
        persistenceDiagnostic = redactPersistenceDiagnostic(parsed);
      } catch { persistenceDiagnostic = { unreadable: true }; }
    }
    const settlementAttachments = this.results.flatMap((entry) => entry.attachments ?? []).filter((entry) => entry.name === "local-corpus-settlement-diagnostic");
    let settlementDiagnostic = null;
    if (settlementAttachments.length === 1) {
      try {
        const attachment = settlementAttachments[0]; const raw = attachment.body ?? (attachment.path ? readFileSync(attachment.path) : null);
        const parsed = raw ? JSON.parse(Buffer.from(raw).toString("utf8")) : null;
        settlementDiagnostic = Object.fromEntries(["expectedEvents", "events", "knownEvents", "badDecode", "productLinkMismatch", "activeReviews", "counted", "products"].map((key) => [key, Number(parsed?.[key]) || 0]));
      } catch { settlementDiagnostic = { unreadable: true }; }
    }
    const latencyAttachments = this.results.flatMap((entry) => entry.attachments ?? []).filter((entry) => entry.name === "local-corpus-latency-diagnostic");
    let latencyDiagnostic = null;
    if (latencyAttachments.length === 1) {
      try { const attachment = latencyAttachments[0]; const raw = attachment.body ?? (attachment.path ? readFileSync(attachment.path) : null); latencyDiagnostic = raw ? JSON.parse(Buffer.from(raw).toString("utf8")) : null; }
      catch { latencyDiagnostic = { unreadable: true }; }
    }
    const status = result.status === "passed" && payload ? "passed" : "failed";
    const receipt = createReceipt({ status, testsExpected: this.total, testsObserved: this.results.length, elapsedMs: Date.now() - this.startedAt, aggregate: payload, persistenceDiagnostic, settlementDiagnostic, latencyDiagnostic, failures: this.results.filter((entry) => entry.status !== "passed").map((entry) => ({ status: entry.status })) });
    const dir = resolve("outputs/boss-barcode-certification"); mkdirSync(dir, { recursive: true });
    const target = resolve(dir, "localhost-synthetic-ui.receipt.json"); const temporary = resolve(dir, `.local-${process.pid}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" }); renameSync(temporary, target);
  }
}
