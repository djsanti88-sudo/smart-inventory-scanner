import csv, os
import validate as v
import ledger as L

_REJECTED_COLS = ["raw_brand", "raw_model", "raw_size", "raw_barcode", "raw_mpn",
                  "source_url", "reject_reason", "harvested_at", "run_id"]
_BACKLOG_COLS = ["canonical_product_uid", "brand", "model", "size_canonical", "size_compact",
                 "barcode", "barcode_type", "manufacturer_part_number", "source_url",
                 "missing_fields", "reason", "harvested_at", "run_id"]


def route_with_reason(identity):
    """Return (dest, reason) where dest is 'trusted' | 'backlog' | 'rejected'."""
    ev = identity.get("evidence_level")
    if ev in ("verified_db", "verified_vendor", "verified_ai"):
        # No-MPN trusted path: valid GTIN + brand + model + size is sufficient.
        ok, reason = v.is_trusted_db_identity(identity)
        if ok:
            return "trusted", ""
        if "gtin" in reason.lower() or "size" in reason.lower():
            return "rejected", reason
        return "backlog", reason
    merged = {**identity, "manufacturer_part_number":
              identity.get("manufacturer_part_number") or identity.get("mpn", "")}
    ok, reason = v.is_trusted_identity(merged)
    if ok:
        return "trusted", ""
    if "gtin" in reason.lower() or "size" in reason.lower():
        return "rejected", reason
    return "backlog", reason


def route(identity):
    return route_with_reason(identity)[0]


def build_flat_row(identity, run_id):
    # Always use the clean model code (or "") for the MPN field — never the barcode.
    mpn = identity.get("mpn","") or identity.get("manufacturer_part_number","")
    # For verified_db and verified_vendor rows, use the barcode as the uid disambiguator
    # so that two rows with the same brand/model/size but different barcodes get different UIDs.
    # Retailer rows (no evidence_level / verified_1src_strong) keep uid from mpn.
    uid_key = identity["barcode"] if identity.get("evidence_level") in ("verified_db", "verified_vendor", "verified_ai") else mpn
    row = {
        "brand": v.normalize_brand(identity["brand"]),
        "model": v.normalize_model(identity["model"]),
        "size_canonical": identity["size_canonical"],
        "size_compact": identity["size_compact"],
        "load_index": identity.get("load_index",""),
        "speed_rating": identity.get("speed_rating",""),
        "tire_type": identity.get("tire_type",""),
        "season": identity.get("season",""),
        "barcode": identity["barcode"],
        "barcode_type": v.barcode_type_label(identity["barcode"]),
        "manufacturer_part_number": mpn,
        "source_url": identity["source_url"],
        "evidence_level": identity.get("evidence_level") or "verified_1src_strong",
        "usable_for": "auto_count_candidate",
        "current_status": "active_retail",
    }
    row["canonical_product_uid"] = v.make_uid(row["brand"], row["model"],
        row["size_canonical"], row["load_index"], row["speed_rating"], uid_key)
    row["missing_fields"] = v.missing_fields_str(row)
    row["field_completeness_score"] = int(round(v.completeness_score(row)*100))
    row["harvested_at"] = v.now_iso()
    row["run_id"] = run_id
    return row


def _append(path, header, rowdict):
    new = not os.path.exists(path)
    with open(path,"a",newline="",encoding="utf-8") as f:
        wtr=csv.DictWriter(f, fieldnames=header)
        if new: wtr.writeheader()
        wtr.writerow({k:rowdict.get(k,"") for k in header}); f.flush()


def _rejected_row(idn, reason, run_id):
    return {
        "raw_brand": idn.get("brand", ""),
        "raw_model": idn.get("model", ""),
        "raw_size": idn.get("size_canonical", "") or idn.get("size", ""),
        "raw_barcode": idn.get("barcode", ""),
        "raw_mpn": idn.get("manufacturer_part_number") or idn.get("mpn", ""),
        "source_url": idn.get("source_url", ""),
        "reject_reason": reason,
        "harvested_at": v.now_iso(),
        "run_id": run_id,
    }


def _backlog_row(idn, reason, run_id):
    mpn = idn.get("manufacturer_part_number") or idn.get("mpn", "")
    brand = idn.get("brand", ""); model = idn.get("model", "")
    size_c = idn.get("size_canonical", ""); bc = idn.get("barcode", "")
    uid = ""
    if brand and model and size_c:
        uid = v.make_uid(v.normalize_brand(brand), v.normalize_model(model), size_c,
                         idn.get("load_index", ""), idn.get("speed_rating", ""), mpn)
    return {
        "canonical_product_uid": uid,
        "brand": brand, "model": model,
        "size_canonical": size_c, "size_compact": idn.get("size_compact", ""),
        "barcode": bc, "barcode_type": v.barcode_type_label(bc) if bc else "",
        "manufacturer_part_number": mpn, "source_url": idn.get("source_url", ""),
        "missing_fields": reason, "reason": reason,
        "harvested_at": v.now_iso(), "run_id": run_id,
    }


def write_rows(identities, paths, led, run_id):
    counts={"trusted":0,"backlog":0,"rejected":0,"dup_skipped":0}
    root = os.path.dirname(paths["flat"])
    rejected_path = paths.get("rejected", os.path.join(root, "rejected_rows.csv"))
    backlog_path = paths.get("backlog", os.path.join(root, "tire_enrichment_backlog.csv"))
    for idn in identities:
        dest, reason = route_with_reason(idn)
        if dest == "rejected":
            _append(rejected_path, _REJECTED_COLS, _rejected_row(idn, reason, run_id))
            counts["rejected"]+=1; continue
        if dest == "backlog":
            _append(backlog_path, _BACKLOG_COLS, _backlog_row(idn, reason, run_id))
            counts["backlog"]+=1; continue
        if L.seen_barcode(led, idn["barcode"]):
            counts["dup_skipped"]+=1; continue
        flat=build_flat_row(idn, run_id)
        with open(paths["flat"],"a",newline="",encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=v.FLAT_COLS).writerow(flat); f.flush()
        if idn.get("retailer_sku"):
            _append(paths["identifiers"],["barcode","retailer_sku","source_url"],
                    {"barcode":idn["barcode"],"retailer_sku":idn["retailer_sku"],"source_url":idn["source_url"]})
        L.record_row(led, flat)
        counts["trusted"]+=1
    return counts
