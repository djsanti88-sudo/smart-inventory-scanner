#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function shouldIgnoreBuild(changedFiles) {
  return (
    changedFiles.length > 0 &&
    changedFiles.every((file) => file.startsWith("docs/") || file.toLowerCase().endsWith(".md"))
  );
}

function changedFilesForHead() {
  const output = execFileSync("git", ["diff", "--name-only", "HEAD^", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  return output
    .split(/\r?\n/)
    .map((file) => file.trim().replaceAll("\\", "/"))
    .filter(Boolean);
}

function main() {
  try {
    const changedFiles = changedFilesForHead();
    const ignoreBuild = shouldIgnoreBuild(changedFiles);
    console.log(
      ignoreBuild
        ? "Ignoring Vercel build: every changed file is documentation."
        : "Continuing Vercel build: commit contains deploy-relevant changes or no safe diff was found.",
    );
    process.exit(ignoreBuild ? 0 : 1);
  } catch {
    console.log("Continuing Vercel build: changed files could not be determined safely.");
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
