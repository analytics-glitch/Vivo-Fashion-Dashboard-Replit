"""
tests.py — Acceptance checks for the Vivo costing sheet PDF generator.

Run with:  python3 tests.py
All 7 checks must pass; any failure raises AssertionError / prints a clear message.
"""

import re
import os
import sys
import tempfile

# Ensure local imports work when run from any directory
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

from costing import build_sheet, _derive

# ── Sample payload ────────────────────────────────────────────────────────────
SAMPLE = {
    "style_name":      "Chela sleeveless waterfall in jersey",
    "style_no":        "V1025015",
    "colour":          "Dark Red",
    "dps":             "DPS00394",
    "order_qty":       208,
    "currency":        "KES",
    "retail_incl_vat": 3900.00,
    "vat_rate":        0.16,
    "groups": [
        {
            "label": "Fabric",
            "lines": [
                {"desc": "Main fabric — fashion knitted 1629, dark red",
                 "barcode": "302954", "qty": 1.43, "unit": "m", "unit_cost": 379.64}
            ]
        },
        {
            "label": "Trims and accessories",
            "lines": [
                {"desc": "Taffeta white ribbon / care label",
                 "barcode": "305149", "qty": 1, "unit": "pc", "unit_cost": 0.15}
            ]
        },
        {
            "label": "CMT / labour",
            "lines": [
                {"desc": "CMT labour — actual, from done DPS",
                 "barcode": None, "qty": 1, "unit": "gmt", "unit_cost": 444.92}
            ]
        }
    ],
    "basis_note": (
        "Fabric valued at the current fabric-master cost per metre. "
        "Trims and accessories at the cost recorded on the DPS / MO. "
        "CMT is actual labour from the completed DPS divided by 208 garments."
    ),
    "signoffs": [
        {"role": "Prepared by",  "name": "Bedan Mwaura",  "signed_at": "29 Jul 2026, 17:22 EAT"},
        {"role": "Checked by",   "name": None,            "signed_at": None},
        {"role": "Approved by",  "name": None,            "signed_at": None}
    ],
    "revisions": [
        "28 Jul 2026, 17:15 — sheet created, Bedan Mwaura",
        "29 Jul 2026, 17:22 — prepared-by signed, step 1 of 3, Bedan Mwaura"
    ],
    "generated_at": "30 Jul 2026, 15:25 EAT"
}


def _page_count(path: str) -> int:
    """Count pages in a PDF by counting Page objects (cross-ref entries)."""
    with open(path, "rb") as fh:
        data = fh.read()
    # Count occurrences of '/Type /Page' (not /Pages) — each is one physical page
    return len(re.findall(rb"/Type\s*/Page[^s]", data))


def _extract_text(path: str) -> str:
    """Extract all visible text from a PDF using pypdf."""
    import pypdf
    reader = pypdf.PdfReader(path)
    parts = []
    for page in reader.pages:
        parts.append(page.extract_text() or "")
    return " ".join(parts)


def check_1_one_page(path: str) -> None:
    """Check 1: output is exactly 1 page."""
    n = _page_count(path)
    assert n == 1, f"Expected 1 page, got {n}"
    print("  ✓ Check 1: exactly 1 page")


def check_2_cogs_margin(data: dict) -> None:
    """Check 2: cogs_pc + margin_pc == 100 to 2 decimal places."""
    d = _derive(data)
    total = round(d["cogs_pc"] + d["margin_pc"], 2)
    assert total == 100.00, f"cogs_pc + margin_pc = {total}, expected 100.00"
    print(f"  ✓ Check 2: cogs_pc ({d['cogs_pc']}) + margin_pc ({d['margin_pc']}) = 100.00")


def check_3_subtotals_equal_total(data: dict) -> None:
    """Check 3: sum of group subtotals == printed total."""
    d = _derive(data)
    recomputed = round(sum(g["subtotal"] for g in d["groups"]), 2)
    assert recomputed == d["total_cost"], (
        f"sum(subtotals)={recomputed} != total_cost={d['total_cost']}"
    )
    print(f"  ✓ Check 3: group subtotals sum to {d['total_cost']}")


def check_4_line_totals(data: dict) -> None:
    """Check 4: each group subtotal == sum of its line totals."""
    d = _derive(data)
    for g in d["groups"]:
        expected = round(sum(ln["line_total"] for ln in g["lines"]), 2)
        assert expected == g["subtotal"], (
            f"Group '{g['label']}': sum(line_totals)={expected} != subtotal={g['subtotal']}"
        )
    print(f"  ✓ Check 4: all {len(d['groups'])} group subtotals match their line totals")


def check_5_no_small_fonts() -> None:
    """Check 5: no ParagraphStyle in costing.py has fontSize < 7."""
    src_path = os.path.join(_HERE, "costing.py")
    with open(src_path) as fh:
        source = fh.read()
    # Extract all _ps() calls and check size argument
    # Pattern: _ps(size, leading, ...) — first positional arg is size
    for m in re.finditer(r"_ps\s*\(\s*([0-9.]+)", source):
        fs = float(m.group(1))
        assert fs >= 7.0, f"Found _ps() call with fontSize={fs} < 7 in costing.py"
    # Also check any explicit fontSize= keyword arg
    for m in re.finditer(r"fontSize\s*=\s*([0-9.]+)", source):
        fs = float(m.group(1))
        assert fs >= 7.0, f"Found fontSize={fs} < 7 in costing.py"
    print("  ✓ Check 5: no font size below 7 pt")


def check_6_no_literal_hex_in_markup() -> None:
    """Check 6: no literal '#RRGGBB' hex string inside any f-string markup builder."""
    src_path = os.path.join(_HERE, "costing.py")
    with open(src_path) as fh:
        source = fh.read()

    # An f-string that builds XML markup will have f'...' or f"..." containing
    # both a { expression } and a # followed by 6 hex digits.
    # We scan f-string literals for embedded literal hex colours.
    # Strategy: find all f-string content (between the quotes after f' or f")
    # and assert none contain a bare #RRGGBB that is NOT inside a { } expression.
    fstring_re = re.compile(r'f["\']([^"\'\\]|\\.|\'\'|"")*["\']', re.DOTALL)
    hex_re     = re.compile(r'"#[0-9A-Fa-f]{6}"')   # literal "#RRGGBB" in markup

    violations = []
    for m in fstring_re.finditer(source):
        body = m.group(0)
        # Remove content inside { } (those are expressions, not literals)
        stripped = re.sub(r"\{[^}]*\}", "", body)
        if hex_re.search(stripped):
            violations.append(m.start())

    assert not violations, (
        f"Literal '#RRGGBB' hex string found inside f-string markup at char positions: {violations}. "
        "Use hx(TOKEN) instead."
    )
    print("  ✓ Check 6: no literal hex strings inside markup f-strings")


def check_7_extracted_text(path: str, data: dict) -> None:
    """Check 7: extracted text contains style number, all barcodes, key headers, and total."""
    text = _extract_text(path)
    d    = _derive(data)

    required = {
        "style_no":  data["style_no"],
        "COGS":      "COGS",
        "Barcode":   "Barcode",
        "Unit cost": "Unit cost, KES",
    }
    # All non-null barcodes
    for g in data["groups"]:
        for ln in g["lines"]:
            if ln["barcode"] is not None:
                required[f"barcode_{ln['barcode']}"] = str(ln["barcode"])

    # Total as formatted number
    total_str = f"{d['total_cost']:,.2f}".replace(",", "")  # strip comma for PDF encoding
    # Try to find either the comma or plain version in extracted text
    total_present = (
        str(int(d["total_cost"])) in text
        or f"{d['total_cost']:.2f}" in text
        or total_str in text
    )
    assert total_present, f"Total cost {d['total_cost']} not found in extracted text"

    for key, needle in required.items():
        assert needle in text, f"Expected '{needle}' ({key}) not found in extracted PDF text"

    print(f"  ✓ Check 7: extracted text contains style no, {len(required)} required strings, and total")


# ── Runner ────────────────────────────────────────────────────────────────────

def run_all() -> None:
    print("\nVivo Costing Sheet — acceptance checks")
    print("=" * 45)

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        path = tmp.name

    try:
        print(f"\nRendering sample sheet → {path}")
        build_sheet(SAMPLE, path)
        print("  Sheet rendered OK\n")

        check_1_one_page(path)
        check_2_cogs_margin(SAMPLE)
        check_3_subtotals_equal_total(SAMPLE)
        check_4_line_totals(SAMPLE)
        check_5_no_small_fonts()
        check_6_no_literal_hex_in_markup()
        check_7_extracted_text(path, SAMPLE)

    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    print("\n" + "=" * 45)
    print("All 7 checks passed ✓")


if __name__ == "__main__":
    run_all()
