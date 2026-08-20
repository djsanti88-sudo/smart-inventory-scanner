#!/usr/bin/env python3
"""Stream-profile the 2.1 GB Open Food Facts intermediate without modifying it."""

from __future__ import annotations

import json
import sys
import time
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "data/retail-knowledge/retail_off.jsonl"
OUTPUT = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else Path(__file__).with_name("retail-source-profile.json")


def present(value: object) -> bool:
    return bool(str(value or "").strip())


started = time.time()
counts: Counter[str] = Counter()
sources: Counter[str] = Counter()
examples: dict[str, list[dict[str, str]]] = {
    "missing_name_with_brand_and_category": [],
    "missing_english_category_with_local_category": [],
}

with SOURCE.open("r", encoding="utf-8", errors="replace") as handle:
    for line_number, line in enumerate(handle, 1):
        counts["rows"] += 1
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            counts["invalid_json_rows"] += 1
            continue

        code = str(row.get("code") or "").strip()
        name = str(row.get("product_name") or "").strip()
        brand = str(row.get("brands") or row.get("brand_owner") or "").strip()
        category_en = str(row.get("main_category_en") or row.get("categories_en") or "").split(",")[0].strip()
        category_local = str(row.get("categories") or "").split(",")[0].strip()
        source = str(row.get("_source") or "").strip()
        sources[source or "<missing>"] += 1

        if not code:
            counts["missing_code_rows"] += 1
        if len(name) < 3:
            counts["excluded_missing_or_short_name_rows"] += 1
            if brand:
                counts["excluded_name_rows_with_brand"] += 1
            if category_en:
                counts["excluded_name_rows_with_english_category"] += 1
            if category_local:
                counts["excluded_name_rows_with_local_category"] += 1
            if brand and (category_en or category_local):
                counts["excluded_name_rows_with_brand_and_category"] += 1
                if len(examples["missing_name_with_brand_and_category"]) < 20:
                    examples["missing_name_with_brand_and_category"].append({
                        "barcode": code,
                        "brand": brand,
                        "category": category_en or category_local,
                    })
        else:
            counts["included_name_rows"] += 1
            if not brand:
                counts["included_rows_missing_brand"] += 1
            if not category_en:
                counts["included_rows_missing_english_category"] += 1
                if category_local:
                    counts["included_rows_local_category_rescue"] += 1
                    if len(examples["missing_english_category_with_local_category"]) < 20:
                        examples["missing_english_category_with_local_category"].append({
                            "barcode": code,
                            "product_name": name,
                            "category_local": category_local,
                        })

        for field in ("quantity", "countries_en", "image_url", "image_small_url"):
            if present(row.get(field)):
                counts[f"rows_with_{field}"] += 1

        if line_number % 500_000 == 0:
            print(f"profiled={line_number:,}", flush=True)

result = {
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "source": str(SOURCE.relative_to(ROOT)).replace("\\", "/"),
    "source_bytes": SOURCE.stat().st_size,
    "counts": dict(sorted(counts.items())),
    "source_values": dict(sources.most_common()),
    "examples": examples,
    "elapsed_seconds": round(time.time() - started, 3),
}

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(json.dumps({"output": str(OUTPUT), "rows": counts["rows"], "elapsed_seconds": result["elapsed_seconds"]}, indent=2))
