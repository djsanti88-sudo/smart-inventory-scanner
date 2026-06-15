#!/usr/bin/env node
// Spend ledger helper for the benchmark + tire-DB task.
// Two ledgers:
//   - reports/spend-ledger.json     : CASH (USD) for Gemini/OpenAI/UPCitemdb/Go-UPC/Barcode Lookup/any paid API. Hard cap $30.
//   - reports/firecrawl-ledger.json : Firecrawl CREDITS (prepaid/abundant, not cash). Hard cap 500 credits, <=50 pages/domain.
//
// Pure-ish module: exports functions for tests; CLI for manual use.
// Usage (CLI):
//   node scripts/spend-ledger.mjs show
//   node scripts/spend-ledger.mjs add-cash <usd> "<provider>" "<note>"
//   node scripts/spend-ledger.mjs add-firecrawl <credits> <pages> "<domain>" "<note>"
//   node scripts/spend-ledger.mjs assert            # exits non-zero if any cap exceeded
//
// All mutations call assertWithinCaps() and THROW before writing if a cap would be crossed.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CASH_PATH = resolve(HERE, "../reports/spend-ledger.json");
export const FIRECRAWL_PATH = resolve(HERE, "../reports/firecrawl-ledger.json");

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

// ---- pure cap math (unit-tested) -----------------------------------------

export function projectedCash(cash, addUsd) {
  return round2(cash.totalUsd + addUsd);
}
export function cashWouldExceed(cash, addUsd) {
  return projectedCash(cash, addUsd) > cash.cap + 1e-9;
}
export function projectedCredits(fc, addCredits) {
  return fc.credits + addCredits;
}
export function firecrawlWouldExceed(fc, addCredits, pages, domain) {
  if (projectedCredits(fc, addCredits) > fc.cap) return true;
  const used = (fc.perDomain && fc.perDomain[domain]) || 0;
  if (used + (pages || 0) > fc.perDomainCap) return true;
  return false;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---- mutations (throw-before-write) --------------------------------------

export function addCash(addUsd, provider, note, ts = "") {
  const cash = readJson(CASH_PATH);
  if (typeof addUsd !== "number" || addUsd < 0 || !Number.isFinite(addUsd)) {
    throw new Error(`addCash: invalid amount ${addUsd}`);
  }
  if (cashWouldExceed(cash, addUsd)) {
    throw new Error(
      `CASH CAP BLOCK: +$${addUsd} would push total to $${projectedCash(cash, addUsd)} over cap $${cash.cap}. Refusing.`
    );
  }
  cash.totalUsd = projectedCash(cash, addUsd);
  cash.entries.push({ ts, provider: String(provider), usd: round2(addUsd), note: String(note || "") });
  writeJson(CASH_PATH, cash);
  return cash;
}

export function addFirecrawl(addCredits, pages, domain, note, ts = "") {
  const fc = readJson(FIRECRAWL_PATH);
  addCredits = Number(addCredits) || 0;
  pages = Number(pages) || 0;
  domain = String(domain || "unknown");
  if (firecrawlWouldExceed(fc, addCredits, pages, domain)) {
    throw new Error(
      `FIRECRAWL CAP BLOCK: +${addCredits} credits / +${pages} pages on "${domain}" would exceed task cap ${fc.cap} or per-domain cap ${fc.perDomainCap}. Refusing.`
    );
  }
  fc.credits = projectedCredits(fc, addCredits);
  fc.perDomain[domain] = ((fc.perDomain && fc.perDomain[domain]) || 0) + pages;
  fc.entries.push({ ts, domain, credits: addCredits, pages, note: String(note || "") });
  writeJson(FIRECRAWL_PATH, fc);
  return fc;
}

export function assertWithinCaps() {
  const cash = readJson(CASH_PATH);
  const fc = readJson(FIRECRAWL_PATH);
  const problems = [];
  if (cash.totalUsd > cash.cap + 1e-9) problems.push(`cash $${cash.totalUsd} > cap $${cash.cap}`);
  if (fc.credits > fc.cap) problems.push(`firecrawl ${fc.credits} > cap ${fc.cap}`);
  for (const [d, used] of Object.entries(fc.perDomain || {})) {
    if (used > fc.perDomainCap) problems.push(`firecrawl domain ${d} ${used} > per-domain ${fc.perDomainCap}`);
  }
  return { ok: problems.length === 0, problems, cashUsd: cash.totalUsd, firecrawlCredits: fc.credits };
}

// ---- CLI ------------------------------------------------------------------

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "show") {
    console.log("CASH:", JSON.stringify(readJson(CASH_PATH), null, 2));
    console.log("FIRECRAWL:", JSON.stringify(readJson(FIRECRAWL_PATH), null, 2));
  } else if (cmd === "add-cash") {
    const [usd, provider, note] = rest;
    console.log(JSON.stringify(addCash(Number(usd), provider, note), null, 2));
  } else if (cmd === "add-firecrawl") {
    const [credits, pages, domain, note] = rest;
    console.log(JSON.stringify(addFirecrawl(Number(credits), Number(pages), domain, note), null, 2));
  } else if (cmd === "assert") {
    const r = assertWithinCaps();
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(1);
  } else {
    console.error("commands: show | add-cash <usd> <provider> <note> | add-firecrawl <credits> <pages> <domain> <note> | assert");
    process.exit(2);
  }
}

if (process.argv[1] && process.argv[1].endsWith("spend-ledger.mjs")) {
  main(process.argv.slice(2));
}
