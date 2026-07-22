import { readFileSync, writeFileSync } from "node:fs";
const j = JSON.parse(readFileSync(".superpowers/stress/codes.json", "utf8"));
const all = [...new Set(Object.values(j.buckets).flat().map((x) => (typeof x === "string" ? x : x.code)))];
const lines = [];
for (let i = 0; i < all.length; i += 10) lines.push(all.slice(i, i + 10).join(" "));
writeFileSync(".superpowers/stress/marathon-all-codes.txt", lines.join("\r\n") + "\r\n");
const back = readFileSync(".superpowers/stress/marathon-all-codes.txt", "utf8").trim().split(/\s+/);
console.log("codes:", all.length, "| re-read:", back.length, "| unique:", new Set(back).size);
