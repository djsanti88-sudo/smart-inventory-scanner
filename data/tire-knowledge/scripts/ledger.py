import json, csv, os
import validate as v

def load_ledger(path):
    if not os.path.exists(path):
        return {"schema_version":"3.0","total_trusted_barcode_rows":0,
                "total_backlog_rows":0,"total_rejected_rows":0,
                "checkpoint_last":0,"checkpoint_next":5000,
                "seen_barcodes":[],"seen_part_numbers":[],"seen_identity_keys":[],
                "seen_source_urls":[],"search_queries_done":[],"cells_done":[],
                "bad_sources":[],"blocked_sources":[],"runs":[]}
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def seen_barcode(ledger, bc):
    return bc in set(ledger["seen_barcodes"])

def record_row(ledger, row):
    bc = row["barcode"]
    if bc not in ledger["seen_barcodes"]:
        ledger["seen_barcodes"].append(bc)
        ledger["total_trusted_barcode_rows"] += 1
    key = v.make_identity_key(row["brand"], row["model"], row["size_canonical"],
                              row.get("load_index",""), row.get("speed_rating",""),
                              row.get("manufacturer_part_number",""))
    if key not in ledger["seen_identity_keys"]:
        ledger["seen_identity_keys"].append(key)
    if row.get("manufacturer_part_number") and row["manufacturer_part_number"] not in ledger["seen_part_numbers"]:
        ledger["seen_part_numbers"].append(row["manufacturer_part_number"])
    if row["source_url"] not in ledger["seen_source_urls"]:
        ledger["seen_source_urls"].append(row["source_url"])

def save_ledger(ledger, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(ledger, f, indent=2)

def counts_match_csv(ledger, flat_csv_path, behind_tolerance=1000):
    """Validate the ledger against the corpus CSV, separating REAL corruption from benign flush-lag.

    The 8.3 MB ledger file is flushed in batches while the CSV is appended continuously, so during an
    active harvest the ledger can sit a little BEHIND the CSV (benign). Real corruption is: CSV duplicate
    barcodes, the ledger AHEAD of the CSV (phantom entries - the bug we fixed before), or the ledger far
    behind (its save is broken). Compare against DISTINCT barcodes so a small batch-flush lag isn't
    confused with duplicates.
    """
    rows = 0
    seen = set()
    with open(flat_csv_path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            rows += 1
            seen.add((r.get("barcode") or "").strip())
    distinct = len(seen)
    led = ledger["total_trusted_barcode_rows"]
    # 1) CSV duplicate barcodes -> ALWAYS a hard fail (double-count corruption).
    if rows != distinct:
        return False, f"csv has {rows - distinct} DUPLICATE barcode rows (rows={rows} distinct={distinct})"
    # 2) Ledger AHEAD of the CSV -> phantom entries (the corruption we fixed before) -> hard fail.
    if led > distinct:
        return False, f"ledger AHEAD of csv (phantom): ledger {led} > csv {distinct}"
    # 3) Ledger far BEHIND the CSV -> its save is broken / real drift -> hard fail.
    if distinct - led > behind_tolerance:
        return False, f"ledger far behind csv: ledger {led} << csv {distinct} (gap {distinct - led} > {behind_tolerance})"
    # else: small ledger-behind-csv lag from batched flushing during an active harvest = benign.
    return True, ""


def rebuild_ledger_from_corpus(root):
    """
    Rebuild seen_barcodes, seen_identity_keys, seen_part_numbers, seen_source_urls,
    and total_trusted_barcode_rows from the current tire_corpus_flat.csv.
    Preserves all other ledger fields (schema_version, runs, cells_done, etc.).
    Returns the updated ledger dict (caller must save it).
    """
    ledger_path = os.path.join(root, "coverage_ledger.json")
    flat_path = os.path.join(root, "tire_corpus_flat.csv")

    led = load_ledger(ledger_path)

    seen_barcodes = []
    seen_identity_keys = []
    seen_part_numbers = []
    seen_source_urls = []

    with open(flat_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            bc = row["barcode"]
            if bc not in seen_barcodes:
                seen_barcodes.append(bc)

            key = v.make_identity_key(
                row["brand"], row["model"], row["size_canonical"],
                row.get("load_index", ""), row.get("speed_rating", ""),
                row.get("manufacturer_part_number", "")
            )
            if key not in seen_identity_keys:
                seen_identity_keys.append(key)

            pn = row.get("manufacturer_part_number", "")
            if pn and pn not in seen_part_numbers:
                seen_part_numbers.append(pn)

            url = row.get("source_url", "")
            if url and url not in seen_source_urls:
                seen_source_urls.append(url)

    led["seen_barcodes"] = seen_barcodes
    led["seen_identity_keys"] = seen_identity_keys
    led["seen_part_numbers"] = seen_part_numbers
    led["seen_source_urls"] = seen_source_urls
    led["total_trusted_barcode_rows"] = len(seen_barcodes)

    return led
