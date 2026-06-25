"""
Gemini grounded verification of barcode<->product correctness (LIVE PAID API).

For a random sample of corpus rows, asks Gemini (with Google Search grounding) to look up
the barcode on the web and confirm it matches the brand/model/size we recorded.

SAFETY:
- Treats Gemini output as UNTRUSTED: results are advisory flags only; this script NEVER
  edits the corpus or any barcode.
- Hard cap on number of live calls (cost guard). Default model is cheap; grounding is the
  cost driver (~$35 / 1000 grounded queries at time of writing).
- Reads GEMINI_API_KEY from ../../.env.local server-side; never prints the key.
- No PII is sent (tire product fields only).
"""
import csv, json, os, re, sys, random, argparse, time
import requests, certifi

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.path.join(ROOT, "..", "..", ".env.local")
OUTDIR = os.path.join(ROOT, "outputs", "gemini_qa")


def load_key():
    txt = open(ENV, encoding="utf-8").read()
    m = re.search(r"GEMINI_API_KEY\s*=\s*(\S+)", txt)
    if not m:
        raise RuntimeError("GEMINI_API_KEY not found in .env.local")
    return m.group(1).strip().strip('"').strip("'")


def build_prompt(row):
    return (
        "You are verifying tire product data against the web. Use Google Search to look up the "
        f"barcode below, then decide if it matches the recorded product.\n\n"
        f"Barcode ({row['barcode_type']}): {row['barcode']}\n"
        f"Recorded brand: {row['brand']}\n"
        f"Recorded model: {row['model']}\n"
        f"Recorded size: {row['size_canonical']}\n"
        f"Manufacturer part number: {row['manufacturer_part_number']}\n\n"
        "Search the web for this exact barcode. Then answer STRICT JSON only (no prose, no code fence):\n"
        '{"match":"yes|no|uncertain","found_product":"<what the barcode resolves to on the web, or empty>",'
        '"reason":"<short>"}\n'
        "Rules: 'yes' only if a credible source shows this barcode for this brand+model (size may vary). "
        "'no' if the web clearly shows a different product. 'uncertain' if you cannot find a credible source. "
        "Do NOT guess; prefer 'uncertain' over inventing."
    )


def call_gemini(key, model, prompt, timeout=60):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "tools": [{"google_search": {}}],
        "generationConfig": {"temperature": 0.0},
    }
    r = requests.post(url, params={"key": key}, json=body, timeout=timeout, verify=certifi.where())
    r.raise_for_status()
    data = r.json()
    cand = (data.get("candidates") or [{}])[0]
    parts = (cand.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts)
    grounded = bool(cand.get("groundingMetadata"))
    return text, grounded


def parse_verdict(text):
    # tolerant JSON extraction; output is untrusted
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return {"match": "parse_error", "found_product": "", "reason": text[:160]}
    try:
        d = json.loads(m.group(0))
        return {"match": str(d.get("match", "parse_error")).lower(),
                "found_product": str(d.get("found_product", ""))[:200],
                "reason": str(d.get("reason", ""))[:200]}
    except Exception:
        return {"match": "parse_error", "found_product": "", "reason": text[:160]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=100)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--model", default="gemini-2.5-flash")
    ap.add_argument("--max-calls", type=int, default=110, help="hard cost guard")
    args = ap.parse_args()

    key = load_key()
    rows = list(csv.DictReader(open(os.path.join(ROOT, "tire_corpus_flat.csv"), encoding="utf-8")))
    rnd = random.Random(args.seed)
    sample = rnd.sample(rows, min(args.n, len(rows)))
    n = min(len(sample), args.max_calls)
    sample = sample[:n]
    os.makedirs(OUTDIR, exist_ok=True)
    out_csv = os.path.join(OUTDIR, f"verify_sample_n{n}_seed{args.seed}.csv")

    results, counts, errors = [], {}, 0
    print(f"[gemini-verify] model={args.model} sample={n} (est ~${n*0.035:.2f} grounding)")
    for i, row in enumerate(sample, 1):
        try:
            text, grounded = call_gemini(key, args.model, build_prompt(row))
            v = parse_verdict(text)
            v["grounded"] = grounded
            errors = 0
        except Exception as e:
            v = {"match": "error", "found_product": "", "reason": str(e)[:160], "grounded": False}
            errors += 1
        counts[v["match"]] = counts.get(v["match"], 0) + 1
        results.append({**{k: row[k] for k in ("barcode", "brand", "model", "size_canonical",
                                               "manufacturer_part_number", "source_url")}, **v})
        if i % 10 == 0 or i == n:
            print(f"  {i}/{n}  " + " ".join(f"{k}={x}" for k, x in sorted(counts.items())))
        if errors >= 5:
            print("  STOPPING: 5 consecutive errors. Check model/grounding support or network.")
            break
        time.sleep(0.3)

    fields = ["barcode", "brand", "model", "size_canonical", "manufacturer_part_number",
              "match", "found_product", "reason", "grounded", "source_url"]
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in results:
            w.writerow({k: r.get(k, "") for k in fields})

    done = len(results)
    print("\n=== SUMMARY ===")
    print("checked      :", done, "of", n)
    for k in sorted(counts):
        print(f"  {k:12s}: {counts[k]}")
    print("est cost     : ~$%.2f" % (done * 0.035))
    print("output       :", out_csv)
    mism = [r for r in results if r["match"] in ("no",)]
    if mism:
        print("\n!! POSSIBLE MISMATCHES (review):")
        for r in mism:
            print(f"  {r['barcode']} {r['brand']} {r['model']} -> {r['reason']}")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    main()
