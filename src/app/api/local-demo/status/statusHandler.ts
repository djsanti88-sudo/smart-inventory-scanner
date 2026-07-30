import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { isLocalDemo } from "@/server/localDemo";
import {
  hasExactKeys,
  isSha256,
  readContainedText,
} from "@/server/localDemoArtifacts";
import {
  isLoopbackRequest,
  localDemoEvidenceErrorResponse,
  localDemoNoStoreHeaders,
  localDemoNotFoundResponse,
} from "@/server/localDemoHttp";

type PreflightResult = { databaseSha256: string };
type StatusOptions = {
  runtimeRoot: string;
  ledgerPath: string | (() => string);
  preflight: () => PreflightResult;
  runtimeSessionNonce?: () => string | undefined;
};

const LEDGER_KEYS = [
  "pid",
  "timestamp",
  "method",
  "protocol",
  "host",
  "path",
] as const;

function isLedgerEntry(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return hasExactKeys(entry, LEDGER_KEYS) &&
    Number.isSafeInteger(entry.pid) &&
    typeof entry.timestamp === "string" &&
    Number.isFinite(Date.parse(entry.timestamp)) &&
    typeof entry.method === "string" &&
    entry.method.length > 0 &&
    entry.method.length <= 16 &&
    typeof entry.protocol === "string" &&
    /^[a-z]+:$/.test(entry.protocol) &&
    typeof entry.host === "string" &&
    entry.host.length > 0 &&
    entry.host.length <= 255 &&
    typeof entry.path === "string" &&
    entry.path.startsWith("/") &&
    entry.path.length <= 2048 &&
    !entry.path.includes("?");
}

export function createLocalDemoStatusHandler(options: StatusOptions) {
  return async function GET(request: NextRequest): Promise<NextResponse> {
    if (!isLocalDemo() || !isLoopbackRequest(request)) {
      return localDemoNotFoundResponse();
    }
    try {
      const preflight = options.preflight();
      if (!isSha256(preflight.databaseSha256)) throw new Error("Invalid database hash");
      const runtimeSessionNonce = options.runtimeSessionNonce?.();
      if (options.runtimeSessionNonce !== undefined && !/^[a-f0-9]{32,}$/i.test(String(runtimeSessionNonce))) {
        throw new Error("Invalid runtime session nonce");
      }
      const ledgerPath = typeof options.ledgerPath === "function"
        ? options.ledgerPath()
        : options.ledgerPath;
      const text = readContainedText(options.runtimeRoot, ledgerPath, 2 * 1024 * 1024);
      const attempts = text.trim() === ""
        ? []
        : text.trimEnd().split(/\r?\n/).map((line) => JSON.parse(line));
      if (attempts.length > 10_000 || !attempts.every(isLedgerEntry)) {
        throw new Error("Invalid egress ledger");
      }
      return NextResponse.json({
        localDemo: true,
        externalDecodeEnabled: false,
        databaseSha256: preflight.databaseSha256,
        ...(runtimeSessionNonce === undefined ? {} : { runtimeSessionNonce }),
        egress: {
          blockedAttemptCount: attempts.length,
          attempts,
        },
      }, { headers: localDemoNoStoreHeaders });
    } catch {
      return localDemoEvidenceErrorResponse();
    }
  };
}
