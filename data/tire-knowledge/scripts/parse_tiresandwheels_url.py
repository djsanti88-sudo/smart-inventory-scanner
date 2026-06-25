import re
from urllib.parse import urlparse, unquote
from validate import normalize_size

# Match: _BARCODE_SIZE at end. SIZE must contain R (for rim, e.g., R17, R18)
# BARCODE can be 8, 11, 12, 13, or 14 digits (EAN8, partial UPC, UPC, EAN13, GTIN14)
_TAIL = re.compile(r"_(\d{8}|\d{11,14})_([A-Za-z0-9+.]*[Rr][0-9.]+)$")

def _size_from_tail(raw: str) -> str:
    # "265+70R17" -> "265/70R17" ; "LT275+65R18" -> "LT275/65R18"
    return raw.replace("+", "/")

def _normalize_barcode(barcode: str) -> str:
    """Normalize barcode to standard length. 11-digit barcodes are padded to 12 with leading 0."""
    bc = barcode.strip()
    if len(bc) == 11:
        bc = "0" + bc
    return bc

def parse_url(url: str):
    p = urlparse(url)
    if "tiresandwheels.com" not in p.netloc:
        return None
    path = unquote(p.path)
    if "/product/tire/" not in path:
        return None
    segs = [s for s in path.split("/") if s]
    # expected: product, tire, {SKU}, {Brand}, {MPN...tail}
    try:
        i = segs.index("tire")
    except ValueError:
        return None
    rest = segs[i + 1:]
    if len(rest) < 3:
        return None
    sku, brand = rest[0], rest[1]

    # Two formats:
    # 1. Slash: .../Brand/{MPN}/{Model}_{BARCODE}_{SIZE} → segs = [..., Brand, MPN, Model_part1, Model_part2_..., ...]
    #    MPN segment is purely digits.
    # 2. Underscore: .../Brand/{MPN}_{Model}_{BARCODE}_{SIZE} → segs = [..., Brand, MPN_ModelPart1, ModelPart2_..., ...]
    #    Segment after Brand contains both digits and non-digits.

    # Determine variant by checking if segment after Brand is purely digits (slash variant)
    after_brand = rest[2]
    is_slash_variant = after_brand.isdigit()

    if is_slash_variant:
        # Slash variant: MPN is rest[2], rest[3:] is the model and tail
        mpn = rest[2]
        tail = "/".join(rest[3:])
    else:
        # Underscore variant: rest[2] is MPN_ModelPart1, rest[3:] is ModelPart2_...
        # Need to split rest[2] on the FIRST underscore to get MPN and first part of model
        mpn_model_part1 = rest[2]
        parts = mpn_model_part1.split("_", 1)
        mpn = parts[0]
        model_part1 = parts[1] if len(parts) > 1 else ""
        # Reconstruct tail: model_part1 + remaining segments + their suffixes
        if len(rest) > 3:
            tail = model_part1 + "/" + "/".join(rest[3:])
        else:
            tail = model_part1 + "/" + rest[3] if len(rest) > 3 else model_part1

    m = _TAIL.search(tail)
    if not m:
        return None
    barcode, size_raw = m.group(1), m.group(2)
    head = tail[:m.start()]

    # At this point, head should be the model (with potential path separators)
    model = head.replace("+", " ").replace("-", " ").replace("_", " ").replace("/", " ").strip()

    size_canonical, size_compact = normalize_size(_size_from_tail(size_raw))
    if not size_canonical:
        return None
    return {
        "brand": brand.replace("-", " ").strip(),
        "model": model,
        "mpn": mpn.strip(),
        "retailer_sku": sku.strip(),
        "barcode": _normalize_barcode(barcode),
        "size_canonical": size_canonical,
        "size_compact": size_compact,
        "source_url": url,
    }
