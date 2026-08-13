"""Fixture tests for the offline Open Food Facts retained-source processor."""

from __future__ import annotations

import csv
import gzip
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "process_off.py"
SPEC = importlib.util.spec_from_file_location("process_off", SCRIPT)
assert SPEC and SPEC.loader
process_off = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(process_off)


FIELDS = [
    "code", "product_name", "abbreviated_product_name", "generic_name",
    "brands", "brands_en", "brand_owner", "main_category", "main_category_en",
    "categories", "categories_en", "food_groups_en", "pnns_groups_1", "pnns_groups_2",
    "quantity", "countries_en", "image_url", "image_small_url", "url", "creator",
    "owner", "last_modified_by", "created_t", "created_datetime", "last_modified_t",
    "last_modified_datetime", "last_updated_t", "last_updated_datetime", "completeness",
    "unique_scans_n", "data_quality_errors_tags", "states_tags",
]


def row(**changes: str) -> dict[str, str]:
    value = {field: "" for field in FIELDS}
    value.update({
        "code": "049000006346",
        "product_name": "  Cola &amp; Lime  ",
        "abbreviated_product_name": "Cola Lime",
        "generic_name": "Carbonated drink",
        "brands": "Acme, Acme Foods",
        "brands_en": "Acme",
        "brand_owner": "Acme Holdings",
        "main_category": "en:sodas",
        "main_category_en": "Sodas",
        "categories": "en:sodas,en:beverages",
        "categories_en": "Sodas,Beverages",
        "food_groups_en": "Sweetened beverages",
        "pnns_groups_1": "Beverages",
        "pnns_groups_2": "Sweetened beverages",
        "quantity": "355 ml",
        "countries_en": "United States",
        "image_url": "https://images.example/full.jpg",
        "image_small_url": "https://images.example/small.jpg",
        "url": "https://world.openfoodfacts.org/product/049000006346",
        "creator": "fixture-user",
        "owner": "fixture-owner",
        "last_modified_by": "fixture-editor",
        "created_t": "100",
        "created_datetime": "1970-01-01T00:01:40Z",
        "last_modified_t": "200",
        "last_modified_datetime": "1970-01-01T00:03:20Z",
        "last_updated_t": "300",
        "last_updated_datetime": "1970-01-01T00:05:00Z",
        "completeness": "0.9",
        "unique_scans_n": "12",
        "data_quality_errors_tags": "en:missing-data",
        "states_tags": "en:complete",
    })
    value.update(changes)
    return value


def write_export(path: Path, rows: list[dict[str, str]], headers: list[str] = FIELDS) -> None:
    with gzip.open(path, "wt", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers, delimiter="\t", extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def upc_for(value: int) -> str:
    payload = f"{value:011d}"
    total = sum(
        int(digit) * (3 if index % 2 == 0 else 1)
        for index, digit in enumerate(reversed(payload))
    )
    return payload + str((10 - (total % 10)) % 10)


class ProcessOffTests(unittest.TestCase):
    def test_retains_evidence_and_canonicalizes_duplicate_observations_independent_of_order(self) -> None:
        """The new source-only retention/duplicate contract does not exist in the legacy processor."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, second = row(), row(product_name="Cola & Lime Zero", categories_en="Sodas")
            results = []
            for name, rows in (("forward", [first, second, first]), ("reverse", [first, first, second])):
                source, output, receipt = root / f"{name}.tsv.gz", root / f"{name}.jsonl", root / f"{name}.receipt.json"
                write_export(source, rows)
                process_off.process_export(source, output, receipt)
                results.append((output.read_text(encoding="utf-8"), json.loads(receipt.read_text(encoding="utf-8"))))

            records = [json.loads(result[0]) for result in results]
            comparison_records = []
            for record_for_comparison in records:
                copy = dict(record_for_comparison)
                copy.pop("_source_export_sha256")
                comparison_records.append(copy)
            self.assertEqual(comparison_records[0], comparison_records[1])
            record = records[0]
            self.assertEqual(record["product_name_raw"], "Cola & Lime Zero")
            self.assertEqual(record["abbreviated_product_name_raw"], "Cola Lime")
            self.assertEqual(record["generic_name_raw"], "Carbonated drink")
            self.assertEqual(record["brands_raw"], "Acme, Acme Foods")
            self.assertEqual(record["brands_en_raw"], "Acme")
            self.assertEqual(record["brand_owner_raw"], "Acme Holdings")
            self.assertEqual(record["main_category_en_raw"], "Sodas")
            self.assertEqual(record["categories_raw"], "en:sodas,en:beverages")
            self.assertEqual(record["food_groups_en_raw"], "Sweetened beverages")
            self.assertEqual(record["countries_en_raw"], "United States")
            self.assertEqual(record["image_url_raw"], "https://images.example/full.jpg")
            self.assertEqual(record["url_raw"], "https://world.openfoodfacts.org/product/049000006346")
            self.assertEqual(record["last_updated_datetime_raw"], "1970-01-01T00:05:00Z")
            self.assertEqual(record["data_quality_errors_tags_raw"], "en:missing-data")
            self.assertEqual(record["_source"], "openfoodfacts")
            self.assertEqual(len(record["_source_export_sha256"]), 64)
            self.assertEqual(len(record["_payload_sha256"]), 64)
            self.assertEqual([item["payload_sha256"] for item in record["_duplicate_observations"]], sorted(item["payload_sha256"] for item in record["_duplicate_observations"]))
            self.assertTrue(any("product_name_raw" in item["differing_raw_fields"] for item in record["_duplicate_observations"]))

            for _, receipt in results:
                self.assertEqual(receipt["raw_rows_scanned"], 3)
                self.assertEqual(receipt["checksum_valid_observations"], 3)
                self.assertEqual(receipt["unique_retained_gtins"], 1)
                self.assertEqual(receipt["identical_duplicates"], 1)
                self.assertEqual(receipt["conflicting_duplicates"], 1)
                self.assertEqual(receipt["output_rows"], 1)
                self.assertEqual(len(receipt["source_sha256"]), 64)
                self.assertEqual(len(receipt["header_sha256"]), 64)
                self.assertEqual(len(receipt["output_sha256"]), 64)

    def test_failed_processing_does_not_replace_existing_output_or_receipt(self) -> None:
        """A failed input open leaves the last promoted source and receipt untouched."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output, receipt = root / "retail_off.jsonl", root / "receipt.json"
            output.write_text("old-output\n", encoding="utf-8")
            receipt.write_text('{"old":true}\n', encoding="utf-8")

            with self.assertRaises(FileNotFoundError):
                process_off.process_export(root / "missing.tsv.gz", output, receipt)

            self.assertEqual(output.read_text(encoding="utf-8"), "old-output\n")
            self.assertEqual(receipt.read_text(encoding="utf-8"), '{"old":true}\n')

    def test_receipt_promotion_failure_restores_exact_prior_output_and_receipt(self) -> None:
        """A later receipt rename cannot strand a new corpus beside an old receipt."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.tsv.gz"
            output, receipt = root / "retail_off.jsonl", root / "receipt.json"
            write_export(source, [row()])
            prior_output = b"prior-output\r\nwith-exact-bytes\x00"
            prior_receipt = b'{"generation":"prior"}\r\n'
            output.write_bytes(prior_output)
            receipt.write_bytes(prior_receipt)
            real_replace = process_off.os.replace

            def fail_receipt_replace(source_path: object, target_path: object) -> None:
                if Path(source_path) == process_off.temp_path_for(receipt) and Path(target_path) == receipt:
                    raise PermissionError("simulated receipt lock")
                real_replace(source_path, target_path)

            with mock.patch.object(process_off.os, "replace", side_effect=fail_receipt_replace):
                with self.assertRaisesRegex(PermissionError, "simulated receipt lock"):
                    process_off.process_export(source, output, receipt)

            self.assertEqual(output.read_bytes(), prior_output)
            self.assertEqual(receipt.read_bytes(), prior_receipt)

    def test_grouping_uses_two_streaming_passes_without_a_sqlite_expansion(self) -> None:
        """The 4M-row path must not expand source payloads into a disk database."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output, receipt = root / "source.tsv.gz", root / "output.jsonl", root / "receipt.json"
            write_export(source, [row(code=upc_for(value), product_name=f"Product {value}") for value in range(1, 65)])
            result = process_off.process_export(source, output, receipt)

            self.assertEqual(result["unique_retained_gtins"], 64)
            self.assertFalse(any(root.glob("process-off-*.sqlite*")))

    def test_retained_payload_is_invariant_to_source_header_order(self) -> None:
        """The fixed retention schema, not TSV header position, defines row evidence."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_a, source_b = root / "a.tsv.gz", root / "b.tsv.gz"
            output_a, output_b = root / "a.jsonl", root / "b.jsonl"
            receipt_a, receipt_b = root / "a.json", root / "b.json"
            source_row = row()
            write_export(source_a, [source_row])
            write_export(source_b, [source_row], list(reversed(FIELDS)))
            process_off.process_export(source_a, output_a, receipt_a)
            process_off.process_export(source_b, output_b, receipt_b)

            first = json.loads(output_a.read_text(encoding="utf-8"))
            second = json.loads(output_b.read_text(encoding="utf-8"))
            first.pop("_source_export_sha256")
            second.pop("_source_export_sha256")
            self.assertEqual(first, second)

    def test_gzip_output_is_supported_for_space_bounded_full_generation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.tsv.gz"
            output = root / "retained.jsonl.gz"
            receipt = root / "receipt.json"
            write_export(source, [row()])

            result = process_off.process_export(source, output, receipt)

            with gzip.open(output, "rt", encoding="utf-8") as handle:
                retained = json.loads(handle.read())
            self.assertEqual(retained["product_name_raw"], "  Cola &amp; Lime  ")
            self.assertEqual(result["output_rows"], 1)


if __name__ == "__main__":
    unittest.main()
