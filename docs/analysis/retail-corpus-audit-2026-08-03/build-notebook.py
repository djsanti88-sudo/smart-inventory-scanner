#!/usr/bin/env python3
"""Build and sequentially execute the stdlib-only companion notebook."""

from __future__ import annotations

import contextlib
import io
import json
import traceback
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).with_name("retail-corpus-audit.ipynb")


def markdown(cell_id: str, source: str) -> dict:
    return {"cell_type": "markdown", "id": cell_id, "metadata": {}, "source": source.splitlines(keepends=True)}


def code(cell_id: str, source: str) -> dict:
    return {
        "cell_type": "code",
        "execution_count": None,
        "id": cell_id,
        "metadata": {},
        "outputs": [],
        "source": source.splitlines(keepends=True),
    }


cells = [
    markdown("tldr", """## tl;dr

The 4,047,273-row retail table has a trustworthy barcode key: every row is unique, numeric, and checksum-valid. The improvement opportunity is the descriptive layer: 31.22% of rows lack brand and 58.64% lack a usable category after sentinel normalization. Unsupported blanks should remain unknown; exact source assertions should be preserved and reviewed rather than inferred.
"""),
    markdown("context", """## Context & Methods

This diagnostic notebook reads the saved outputs of three complete, local, read-only profilers: the serving SQLite table, the 4.37M-row retained Open Food Facts intermediate, and the 319-row Barcode Lookup pilot. No live APIs or database writes are used.

### Key Assumptions

- A barcode is valid when it is numeric, 8/12/13/14 digits, and passes GS1 Mod-10.
- Category sentinels such as `Undefined` and `Null` are missing values, not usable taxonomy.
- Repeated names across different GTINs are not duplicate physical products without stronger evidence.
"""),
    code("load", """import json
from pathlib import Path

DATA_DIR = Path.cwd() / "docs" / "analysis" / "retail-corpus-audit-2026-08-03"
profile = json.loads((DATA_DIR / "retail-profile.json").read_text(encoding="utf-8"))
source_profile = json.loads((DATA_DIR / "retail-source-profile.json").read_text(encoding="utf-8"))
pilot_profile = json.loads((DATA_DIR / "retail-pilot-profile.json").read_text(encoding="utf-8"))
print("Loaded:", profile["table"]["rows"], source_profile["counts"]["rows"], pilot_profile["counts"]["rows"])
"""),
    markdown("data", """## Data

The serving grain is one row per barcode. The source intermediate is one retained, checksum-valid Open Food Facts record per barcode after its upstream deduplication step. The pilot is a separate general-retail source and is reconciled through the same zero-padding variants used by runtime lookup.
"""),
    code("headline", """total = profile["table"]["rows"]
sentinels = profile["table"]["category_nonblank_sentinel_rows"]
effective_category_missing = profile["table"]["missing_category"] + sentinels

headline = {
    "rows": total,
    "distinct_barcodes": profile["table"]["distinct_barcodes"],
    "valid_gtin_rate": profile["barcode"]["checksum_valid_rows"] / total,
    "brand_missing_rate": profile["table"]["missing_brand"] / total,
    "effective_category_missing_rate": effective_category_missing / total,
    "both_brand_and_category_rate": profile["table"]["rows_with_brand_and_category"] / total,
}
for key, value in headline.items():
    print(f"{key}: {value:.4%}" if key.endswith("rate") else f"{key}: {value:,}")
"""),
    markdown("results", """## Results

The first table distinguishes truly safe cleanup from evidence gaps. Only exact, reversible transformations belong in automatic fill jobs.
"""),
    code("opportunities", """opportunities = [
    ("blank brand", profile["table"]["missing_brand"], "do not infer"),
    ("blank category", profile["table"]["missing_category"], "do not infer"),
    ("category sentinel", sentinels, "normalize to missing; preserve raw"),
    ("localized category rescue", source_profile["counts"]["included_rows_local_category_rescue"], "source assertion; review taxonomy"),
    ("excluded row with brand + category", source_profile["counts"]["excluded_name_rows_with_brand_and_category"], "partial/review only"),
    ("new Barcode Lookup pilot row", pilot_profile["counts"]["new_barcode_rows"], "license + evidence adjudication"),
]
print(f"{'finding':38} {'rows':>12}  handling")
for finding, rows, handling in opportunities:
    print(f"{finding:38} {rows:12,}  {handling}")
"""),
    code("source_evidence", """source_total = source_profile["counts"]["rows"]
for label, key in [
    ("country", "rows_with_countries_en"),
    ("image URL", "rows_with_image_url"),
    ("quantity", "rows_with_quantity"),
]:
    rows = source_profile["counts"][key]
    print(f"{label:10}: {rows:>10,} ({rows/source_total:.2%})")
"""),
    markdown("takeaways", """## Takeaways

1. Add field-level provenance, raw values, source timestamps, and a `UNIQUE` barcode constraint before any broad enrichment.
2. Normalize sentinels, repeated whitespace, HTML entities, and proven double-encoding into separate normalized fields while preserving raw evidence.
3. Route 40,996 source-backed but nameless brand+category rows to partial/review status; never manufacture names.
4. Use a versioned taxonomy map and brand-assertion model instead of overwriting raw strings.
5. Prioritize new retail sources from real scan-miss telemetry and adjudicate source conflicts before promotion to `known`.
"""),
]

namespace = {"__name__": "__notebook__"}
execution_count = 0
for cell in cells:
    if cell["cell_type"] != "code":
        continue
    execution_count += 1
    stdout = io.StringIO()
    try:
        with contextlib.redirect_stdout(stdout):
            exec(compile("".join(cell["source"]), f"<{cell['id']}>", "exec"), namespace)
        cell["execution_count"] = execution_count
        output = stdout.getvalue()
        if output:
            cell["outputs"].append({"name": "stdout", "output_type": "stream", "text": output.splitlines(keepends=True)})
    except Exception as exc:  # pragma: no cover - turns generation failure into inspectable output
        cell["execution_count"] = execution_count
        cell["outputs"].append({
            "ename": type(exc).__name__,
            "evalue": str(exc),
            "output_type": "error",
            "traceback": traceback.format_exc().splitlines(),
        })
        raise

notebook = {
    "cells": cells,
    "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python", "version": "3.12"},
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}
OUT.write_text(json.dumps(notebook, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
json.loads(OUT.read_text(encoding="utf-8"))
print(f"Wrote and sequentially executed {OUT}")
