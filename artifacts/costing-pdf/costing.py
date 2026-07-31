"""
costing.py — Vivo Fashion Group product costing sheet PDF generator.

Entry point:
    build_sheet(data: dict, out_path: str) -> str
    Returns out_path on success. Raises ValueError / RuntimeError on bad data or
    layout overflow (> 1 page).
"""

from __future__ import annotations
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, white, Color
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_RIGHT, TA_CENTER
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame,
    Paragraph, Spacer, Table, TableStyle, Flowable,
    HRFlowable,
)

# ── Palette ───────────────────────────────────────────────────────────────────
INK        = HexColor("#1A1A19")
MUTED      = HexColor("#4E4D49")
FAINT      = HexColor("#6B6A65")
HAIR       = HexColor("#C4C3BC")
RULE_C     = HexColor("#8B8A83")
PANEL      = HexColor("#EFEEE8")
BLUE_D     = HexColor("#1F5FAA")
BLUE_M     = HexColor("#6BA3DE")
BLUE_L     = HexColor("#93BEE8")
BLUE_BG    = HexColor("#DCE9F7")
GREEN_TX   = HexColor("#3B6D11")
GREEN_BG   = HexColor("#E0EDD4")
LOGO_COLOR = HexColor("#F15A24")
WHITE      = white


def hx(c: Color) -> str:
    """Return a hex color string from a reportlab Color for use in Paragraph markup.

    Never write a literal '#RRGGBB' inside markup-building f-strings — always
    call hx(TOKEN) so palette changes propagate automatically.
    """
    return "#%02X%02X%02X" % (int(c.red * 255), int(c.green * 255), int(c.blue * 255))


# ── Page geometry ─────────────────────────────────────────────────────────────
PAGE_W, PAGE_H = A4          # 595.28 × 841.89 pt
MARGIN        = 15 * mm      # 42.52 pt
FOOTER_EXTRA  = 6            # pt of extra headroom below content for the rule
BOT_MARGIN    = MARGIN + FOOTER_EXTRA
CW            = PAGE_W - 2 * MARGIN   # ≈ 510.24 pt

# ── Logo sizing constants ─────────────────────────────────────────────────────
TITLE_PT      = 16.0
HELV_CAP      = 0.717
LOGO_TO_TITLE = 0.62
_TARGET_CAP   = TITLE_PT * HELV_CAP * LOGO_TO_TITLE   # ≈ 7.09 pt

_THIS_DIR  = os.path.dirname(os.path.abspath(__file__))
_ASSET_DIR = os.path.join(_THIS_DIR, "assets")
_LOGO_SRC  = os.path.join(_ASSET_DIR, "vivo-logo.png")
_LOGO_PROC = os.path.join(_ASSET_DIR, "vivo-logo.processed.png")
_LOGO_MARK = os.path.join(_ASSET_DIR, ".processed")

_LOGO_CACHE: dict | None = None


def _get_logo() -> dict:
    """Return logo info (cached). Keys: kind='image'|'text', plus w/h/path or font_size."""
    global _LOGO_CACHE
    if _LOGO_CACHE is not None:
        return _LOGO_CACHE

    # Preprocessing (once): crop + corner transparency
    if os.path.exists(_LOGO_SRC) and not os.path.exists(_LOGO_MARK):
        try:
            from PIL import Image as PILImage
            img = PILImage.open(_LOGO_SRC).convert("RGBA")
            iw, ih = img.size
            pix = img.load()
            # Erase near-white background so corners print as curves
            for y in range(ih):
                for x in range(iw):
                    r, g, b, a = pix[x, y]
                    if r > 235 and g > 230 and b > 220:
                        pix[x, y] = (r, g, b, 0)
            # Crop to non-transparent bounding box
            bbox = img.getbbox()
            if bbox:
                img = img.crop(bbox)
            os.makedirs(_ASSET_DIR, exist_ok=True)
            img.save(_LOGO_PROC, "PNG")
            open(_LOGO_MARK, "w").close()
        except Exception:
            pass   # Fall through to text fallback

    if os.path.exists(_LOGO_PROC):
        try:
            from PIL import Image as PILImage
            img = PILImage.open(_LOGO_PROC).convert("RGBA")
            iw, ih = img.size
            pix = img.load()
            # Measure white wordmark height for cap_frac
            min_y, max_y = ih, 0
            for y in range(ih):
                for x in range(iw):
                    r, g, b, a = pix[x, y]
                    if r > 200 and g > 200 and b > 200 and a > 100:
                        if y < min_y:
                            min_y = y
                        if y > max_y:
                            max_y = y
            cap_frac = (max_y - min_y) / ih if max_y > min_y else 0.4
            logo_h = _TARGET_CAP / cap_frac
            logo_w = logo_h * iw / ih
            _LOGO_CACHE = {"kind": "image", "w": logo_w, "h": logo_h, "path": _LOGO_PROC}
            return _LOGO_CACHE
        except Exception:
            pass

    # Text fallback: "VIVO" in Helvetica-Bold at LOGO_COLOR
    font_size = _TARGET_CAP / HELV_CAP   # size so cap height == _TARGET_CAP
    _LOGO_CACHE = {"kind": "text", "font_size": max(7.0, font_size)}
    return _LOGO_CACHE


# ── Derived-value computation ─────────────────────────────────────────────────

def _derive(data: dict) -> dict:
    """Compute all required derived values. Raises ValueError on constraint violation."""
    vat   = float(data["vat_rate"])
    retail = float(data["retail_incl_vat"])
    selling = retail / (1 + vat)

    groups: list[dict] = []
    total_cost = 0.0
    for g in data["groups"]:
        lines = []
        gsub = 0.0
        for ln in g["lines"]:
            lt = round(float(ln["qty"]) * float(ln["unit_cost"]), 2)
            lines.append({**ln, "line_total": lt})
            gsub += lt
        gsub = round(gsub, 2)
        groups.append({"label": g["label"], "lines": lines, "subtotal": gsub})
        total_cost += gsub

    total_cost   = round(total_cost, 2)
    margin_value = round(selling - total_cost, 2)
    margin_pc    = round(margin_value / selling * 100, 2) if selling else 0.0
    cogs_pc      = round(total_cost  / selling * 100, 2) if selling else 0.0

    if abs(cogs_pc + margin_pc - 100) >= 0.01:
        raise ValueError(
            f"Accounting identity violated: cogs_pc={cogs_pc} + margin_pc={margin_pc} "
            f"= {cogs_pc + margin_pc:.4f}, expected 100.00"
        )

    # Signoff status
    signoffs = data.get("signoffs", [])
    n_signed = sum(1 for s in signoffs if s.get("name"))
    n_total  = len(signoffs)
    if n_total == 0 or n_signed == 0:
        status, status_sub = "Unsigned", None
    elif n_signed == n_total:
        status, status_sub = "Fully signed", None
    else:
        status     = "Partially signed"
        status_sub = f"{n_signed} of {n_total} approvals complete"

    return {
        **data,
        "groups":       groups,
        "selling":      round(selling, 2),
        "total_cost":   total_cost,
        "margin_value": margin_value,
        "margin_pc":    margin_pc,
        "cogs_pc":      cogs_pc,
        "status":       status,
        "status_sub":   status_sub,
    }


# ── Paragraph style factory ───────────────────────────────────────────────────
_PS_COUNTER = 0


def _ps(size: float, leading: float, color: Color, align=TA_LEFT,
        bold: bool = False, name: str = "") -> ParagraphStyle:
    global _PS_COUNTER
    assert size >= 7, f"ParagraphStyle has fontSize {size} < 7 (minimum is 7 pt)"
    _PS_COUNTER += 1
    fn = "Helvetica-Bold" if bold else "Helvetica"
    return ParagraphStyle(
        name or f"_ps{_PS_COUNTER}",
        fontName=fn, fontSize=size, leading=leading,
        textColor=color, alignment=align,
        wordWrap="LTR", leftIndent=0, rightIndent=0,
        spaceBefore=0, spaceAfter=0,
    )


# ── Bezier rounded-corner path helpers ────────────────────────────────────────
_K = 0.5523  # bezier kappa for quarter-circle approximation


def _p_round_left(path, x, y, w, h, r):
    """Rectangle with only the left two corners rounded."""
    path.moveTo(x + r, y)
    path.lineTo(x + w, y)
    path.lineTo(x + w, y + h)
    path.lineTo(x + r, y + h)
    path.curveTo(x + r - _K * r, y + h,  x, y + h - r + _K * r,  x, y + h - r)
    path.lineTo(x, y + r)
    path.curveTo(x, y + r - _K * r,  x + r - _K * r, y,  x + r, y)
    path.close()


def _p_round_right(path, x, y, w, h, r):
    """Rectangle with only the right two corners rounded."""
    path.moveTo(x, y)
    path.lineTo(x + w - r, y)
    path.curveTo(x + w - r + _K * r, y,  x + w, y + r - _K * r,  x + w, y + r)
    path.lineTo(x + w, y + h - r)
    path.curveTo(x + w, y + h - r + _K * r,  x + w - r + _K * r, y + h,  x + w - r, y + h)
    path.lineTo(x, y + h)
    path.close()


def _p_round_all(path, x, y, w, h, r):
    """Full rounded rectangle."""
    path.moveTo(x + r, y)
    path.lineTo(x + w - r, y)
    path.curveTo(x + w - r + _K * r, y,  x + w, y + r - _K * r,  x + w, y + r)
    path.lineTo(x + w, y + h - r)
    path.curveTo(x + w, y + h - r + _K * r,  x + w - r + _K * r, y + h,  x + w - r, y + h)
    path.lineTo(x + r, y + h)
    path.curveTo(x + r - _K * r, y + h,  x, y + h - r + _K * r,  x, y + h - r)
    path.lineTo(x, y + r)
    path.curveTo(x, y + r - _K * r,  x + r - _K * r, y,  x + r, y)
    path.close()


# ── Custom flowable: stacked horizontal bar ───────────────────────────────────
_BAR_COLORS = [BLUE_D, BLUE_M, BLUE_L]


class StackedBar(Flowable):
    """Horizontal stacked bar with rounded end-caps and gaps between segments."""

    def __init__(self, segments: list[tuple[str, float]], width=None,
                 bar_h=9.0, radius=1.5, gap=2.0):
        """
        segments: [(label, fraction), ...] already sorted descending, fractions sum to 1.
        """
        super().__init__()
        self._segs  = segments
        self._w     = width or CW
        self._bar_h = bar_h
        self._r     = radius
        self._gap   = gap

    def wrap(self, aw, ah):
        return self._w, self._bar_h

    def draw(self):
        c   = self.canv
        n   = len(self._segs)
        if not n:
            return
        total_fracs = sum(f for _, f in self._segs)
        gap_total   = (n - 1) * self._gap
        avail_w     = self._w - gap_total
        x = 0.0
        for i, (label, frac) in enumerate(self._segs):
            seg_w = avail_w * (frac / total_fracs) if total_fracs else avail_w / n
            col   = _BAR_COLORS[i] if i < len(_BAR_COLORS) else BLUE_L
            c.setFillColor(col)
            path = c.beginPath()
            if n == 1:
                _p_round_all(path, x, 0, seg_w, self._bar_h, self._r)
            elif i == 0:
                _p_round_left(path, x, 0, seg_w, self._bar_h, self._r)
            elif i == n - 1:
                _p_round_right(path, x, 0, seg_w, self._bar_h, self._r)
            else:
                path.moveTo(x, 0)
                path.lineTo(x + seg_w, 0)
                path.lineTo(x + seg_w, self._bar_h)
                path.lineTo(x, self._bar_h)
                path.close()
            c.drawPath(path, fill=1, stroke=0)
            x += seg_w + self._gap


# ── Footer (canvas-level, not a flowable) ─────────────────────────────────────
def _draw_footer(canvas, doc, data: dict) -> None:
    canvas.saveState()
    y_rule = BOT_MARGIN - 4
    canvas.setStrokeColor(HAIR)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, y_rule, MARGIN + CW, y_rule)

    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(MUTED)
    y_text = y_rule - 9
    left  = (
        f"Vivo Fashion Group \u00b7 Fabric BI \u00b7 "
        f"generated {data['generated_at']} \u00b7 all amounts in {data['currency']}"
    )
    right = (
        f"{data['style_no']} \u00b7 {data['colour']} \u00b7 "
        f"page {canvas.getPageNumber()}"
    )
    canvas.drawString(MARGIN, y_text, left)
    canvas.drawRightString(MARGIN + CW, y_text, right)
    canvas.restoreState()


# ── Section builders ──────────────────────────────────────────────────────────

def _section_header(d: dict, logo: dict) -> list:
    status     = d["status"]
    status_sub = d.get("status_sub")

    # Status cell (right-aligned, bottom-anchored)
    status_markup = (
        f'<font name="Helvetica-Bold" size="8" color="{hx(MUTED)}">{status}</font>'
    )
    if status_sub:
        status_markup += (
            f'<br/><font name="Helvetica" size="7.5" color="{hx(MUTED)}">{status_sub}</font>'
        )
    status_para = Paragraph(status_markup, _ps(8, 11, MUTED, align=TA_RIGHT))

    # Logo cell
    if logo["kind"] == "image":
        from reportlab.platypus import Image as RLImage
        logo_cell = RLImage(
            logo["path"], width=logo["w"], height=logo["h"],
            preserveAspectRatio=True, anchor="sw", mask="auto",
        )
    else:
        fs = logo["font_size"]
        logo_cell = Paragraph(
            f'<font name="Helvetica-Bold" size="{fs:.1f}" color="{hx(LOGO_COLOR)}">V&nbsp;I&nbsp;V&nbsp;O</font>',
            _ps(max(7.0, fs), max(7.0, fs) * 1.2, LOGO_COLOR),
        )

    hdr = Table(
        [[logo_cell, status_para]],
        colWidths=[CW * 0.5, CW * 0.5],
    )
    hdr.setStyle(TableStyle([
        ("VALIGN",        (0, 0), (-1, -1), "BOTTOM"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 0),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
        ("TOPPADDING",    (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))

    return [
        hdr,
        Spacer(0, 6),
        HRFlowable(width=CW, thickness=1.0, color=RULE_C, spaceAfter=0),
        Spacer(0, 8),
    ]


def _section_identity(d: dict) -> list:
    left_para = Paragraph(
        f'<font name="Helvetica" size="11" color="{hx(INK)}">{d["style_name"]}</font>',
        _ps(11, 14, INK),
    )
    right_markup = (
        f'<font color="{hx(MUTED)}">Style&nbsp;</font>'
        f'<font color="{hx(INK)}">{d["style_no"]}</font>'
        f'<font color="{hx(MUTED)}">&nbsp;\u00b7&nbsp;Colour&nbsp;</font>'
        f'<font color="{hx(INK)}">{d["colour"]}</font>'
        f'<font color="{hx(MUTED)}">&nbsp;\u00b7&nbsp;Costed from&nbsp;</font>'
        f'<font color="{hx(INK)}">{d["dps"]}</font>'
        f'<font color="{hx(MUTED)}">&nbsp;\u00b7&nbsp;Order qty&nbsp;</font>'
        f'<font color="{hx(INK)}">{d["order_qty"]:,}</font>'
        f'<font color="{hx(MUTED)}">&nbsp;garments</font>'
    )
    right_para = Paragraph(right_markup, _ps(8, 11, INK, align=TA_RIGHT))

    tbl = Table(
        [[left_para, right_para]],
        colWidths=[CW * 0.42, CW * 0.58],
    )
    tbl.setStyle(TableStyle([
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 0),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
        ("TOPPADDING",    (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))

    return [tbl, Spacer(0, 9)]


def _kpi_tile(label: str, value: str, note: str,
              fill: Color, lc: Color, vc: Color, nc: Color,
              tile_w: float) -> list:
    """Return list of flowables for one KPI tile (label / value / note)."""
    pad_h = 7   # horizontal padding inside tile handled by Table
    inner_w = tile_w - 2 * pad_h
    return [
        Paragraph(
            f'<font name="Helvetica" size="7" color="{hx(lc)}">{label}</font>',
            _ps(7, 9.5, lc, align=TA_CENTER),
        ),
        Spacer(inner_w, 3),
        Paragraph(
            f'<font name="Helvetica" size="14" color="{hx(vc)}">{value}</font>',
            _ps(14, 16, vc, align=TA_CENTER),
        ),
        Spacer(inner_w, 1),
        Paragraph(
            f'<font name="Helvetica" size="7" color="{hx(nc)}">{note}</font>',
            _ps(7, 9.5, nc, align=TA_CENTER),
        ),
    ]


def _section_kpi(d: dict) -> list:
    tile_w = CW / 6

    specs = [
        # (label, value_str, note, fill, lc, vc, nc)
        ("Retail price",     f'{d["retail_incl_vat"]:,.0f}', "KES, VAT-incl",   PANEL,    MUTED, INK,     MUTED),
        ("Selling price",    f'{d["selling"]:,.0f}',          "KES, ex-VAT",     PANEL,    MUTED, INK,     MUTED),
        ("Cost per garment", f'{d["total_cost"]:,.0f}',       "KES, all-in",     PANEL,    MUTED, INK,     MUTED),
        ("COGS",             f'{d["cogs_pc"]:.1f}%',          "of ex-VAT price", BLUE_BG,  BLUE_D, BLUE_D, BLUE_D),
        ("Margin",           f'{d["margin_value"]:,.0f}',     "KES per garment", PANEL,    MUTED, INK,     MUTED),
        ("Margin",           f'{d["margin_pc"]:.1f}%',        "of ex-VAT price", GREEN_BG, GREEN_TX, GREEN_TX, GREEN_TX),
    ]

    cells = [
        _kpi_tile(label, value, note, fill, lc, vc, nc, tile_w)
        for label, value, note, fill, lc, vc, nc in specs
    ]

    row = [cells]   # one table row, 6 columns
    tbl = Table(row, colWidths=[tile_w] * 6)

    style_cmds = [
        ("LEFTPADDING",   (0, 0), (-1, -1), 7),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 7),
        ("TOPPADDING",    (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        # White column gaps between tiles
        *[("LINEAFTER", (i, 0), (i, 0), 2, WHITE) for i in range(5)],
        # HAIR border on each tile
        *[("BOX", (i, 0), (i, 0), 0.5, HAIR) for i in range(6)],
        # Background fills
        *[("BACKGROUND", (i, 0), (i, 0), specs[i][3]) for i in range(6)],
    ]
    tbl.setStyle(TableStyle(style_cmds))

    return [tbl, Spacer(0, 11)]


def _section_composition(d: dict) -> list:
    """Cost composition section: label + stacked bar + legend."""
    groups = d["groups"]
    total  = d["total_cost"] or 1.0

    # Sort groups descending by subtotal
    sorted_groups = sorted(groups, key=lambda g: g["subtotal"], reverse=True)
    segments = [(g["label"], g["subtotal"] / total) for g in sorted_groups]

    # Section label
    lbl = Paragraph(
        f'<font name="Helvetica" size="7.5" color="{hx(MUTED)}">WHERE THE COST SITS</font>',
        _ps(7.5, 10, MUTED, bold=False),
    )

    bar = StackedBar(segments, width=CW, bar_h=9.0, radius=1.5, gap=2.0)

    # Legend row: equal columns per group (up to 3 = len(segments))
    n_segs = len(segments)
    leg_col_w = CW / n_segs
    legend_cells = []
    for i, (label, frac) in enumerate(segments):
        g_sub = sorted_groups[i]["subtotal"]
        col   = _BAR_COLORS[i] if i < len(_BAR_COLORS) else BLUE_L
        pct   = frac * 100

        # Swatch: a tiny coloured Table cell
        swatch = Table(
            [[""]],
            colWidths=[6], rowHeights=[6],
        )
        swatch.setStyle(TableStyle([
            ("BACKGROUND",    (0, 0), (0, 0), col),
            ("LEFTPADDING",   (0, 0), (-1, -1), 0),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
            ("TOPPADDING",    (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]))

        text_markup = (
            f'<font name="Helvetica" size="8" color="{hx(INK)}">{label}&nbsp;</font>'
            f'<font name="Helvetica" size="7" color="{hx(MUTED)}">{pct:.1f}%</font>'
        )
        text_para = Paragraph(text_markup, _ps(8, 10, INK))

        subtotal_para = Paragraph(
            f'<font name="Helvetica-Bold" size="8" color="{hx(INK)}">{g_sub:,.2f}</font>',
            _ps(8, 10, INK, bold=True, align=TA_RIGHT),
        )

        inner = Table(
            [[swatch, text_para, subtotal_para]],
            colWidths=[8, leg_col_w - 8 - 45, 45],
        )
        inner.setStyle(TableStyle([
            ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING",   (0, 0), (-1, -1), 0),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
            ("TOPPADDING",    (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]))
        legend_cells.append(inner)

    legend_tbl = Table([legend_cells], colWidths=[leg_col_w] * n_segs)
    legend_tbl.setStyle(TableStyle([
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 0),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
        ("TOPPADDING",    (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))

    return [
        lbl,
        Spacer(0, 6),
        bar,
        Spacer(0, 7),
        legend_tbl,
        Spacer(0, 12),
    ]


def _section_table(d: dict) -> list:
    """Cost build-up table with group rows, subtotals, and pricing summary."""
    col_fracs = [0.42, 0.13, 0.13, 0.16, 0.16]
    col_w     = [CW * f for f in col_fracs]

    # ── Styles ──────────────────────────────────────────────────────────────
    s_hdr   = _ps(7.5, 10, MUTED, bold=True)
    s_hdr_r = _ps(7.5, 10, MUTED, bold=True, align=TA_RIGHT)
    s_grp   = _ps(7, 10, BLUE_D, bold=True)
    s_body  = _ps(8, 11, INK)
    s_body_r= _ps(8, 11, INK, align=TA_RIGHT)
    s_sub   = _ps(8, 11, INK, bold=True)
    s_sub_r = _ps(8, 11, INK, bold=True, align=TA_RIGHT)
    s_tot   = _ps(9.5, 13, INK, bold=True)
    s_tot_r = _ps(9.5, 13, INK, bold=True, align=TA_RIGHT)
    s_pr    = _ps(8, 11, MUTED)
    s_pr_r  = _ps(8, 11, MUTED, align=TA_RIGHT)
    s_mg    = _ps(8, 11, GREEN_TX, bold=True)
    s_mg_r  = _ps(8, 11, GREEN_TX, bold=True, align=TA_RIGHT)

    def qty_markup(qty, unit):
        return (
            f'<font name="Helvetica" size="8" color="{hx(INK)}">{qty}</font>'
            f'<font name="Helvetica" size="7" color="{hx(MUTED)}"> {unit}</font>'
        )

    def uc_markup(uc, unit):
        return (
            f'<font name="Helvetica" size="8" color="{hx(INK)}">{uc:.2f}</font>'
            f'<font name="Helvetica" size="7" color="{hx(MUTED)}"> /{unit}</font>'
        )

    # ── Accumulate table data & styles ───────────────────────────────────────
    rows   = []
    cmds   = []

    def ri():
        return len(rows)

    # Header row
    rows.append([
        Paragraph("Cost build-up",   s_hdr),
        Paragraph("Barcode",         s_hdr),
        Paragraph("Qty",             s_hdr_r),
        Paragraph("Unit cost, KES",  s_hdr_r),
        Paragraph("Line total, KES", s_hdr_r),
    ])
    cmds += [
        ("TOPPADDING",    (0, 0), (-1, 0), 0),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 4),
        ("LINEBELOW",     (0, 0), (-1, 0), 0.6, RULE_C),
    ]

    for g in d["groups"]:
        # Group label row (spans all 5 cols)
        grp_row_idx = ri()
        rows.append([
            Paragraph(g["label"].upper(), s_grp),
            "", "", "", "",
        ])
        cmds += [
            ("SPAN",          (0, grp_row_idx), (-1, grp_row_idx)),
            ("TOPPADDING",    (0, grp_row_idx), (-1, grp_row_idx), 8),
            ("BOTTOMPADDING", (0, grp_row_idx), (-1, grp_row_idx), 2),
        ]

        # Line rows
        for ln in g["lines"]:
            r_idx = ri()
            barcode = ln["barcode"] if ln["barcode"] is not None else "\u2014"
            unit    = ln.get("unit", "")
            qty_val = ln["qty"]
            uc_val  = float(ln["unit_cost"])
            lt_val  = ln["line_total"]

            rows.append([
                Paragraph(ln["desc"], s_body),
                Paragraph(str(barcode), s_body),
                Paragraph(qty_markup(qty_val, unit), s_body_r),
                Paragraph(uc_markup(uc_val, unit),   s_body_r),
                Paragraph(f'{lt_val:,.2f}',           s_body_r),
            ])
            cmds += [
                ("TOPPADDING",    (0, r_idx), (-1, r_idx), 3.2),
                ("BOTTOMPADDING", (0, r_idx), (-1, r_idx), 3.2),
                ("LINEBELOW",     (0, r_idx), (-1, r_idx), 0.5, HAIR),
            ]

        # Subtotal row
        sub_idx = ri()
        rows.append([
            Paragraph(f'{g["label"]} subtotal', s_sub),
            "", "", "",
            Paragraph(f'{g["subtotal"]:,.2f}', s_sub_r),
        ])
        cmds += [
            ("SPAN",          (0, sub_idx), (3, sub_idx)),
            ("TOPPADDING",    (0, sub_idx), (-1, sub_idx), 3.2),
            ("BOTTOMPADDING", (0, sub_idx), (-1, sub_idx), 3.2),
            ("LINEBELOW",     (0, sub_idx), (-1, sub_idx), 0.6, RULE_C),
        ]

    # Total cost row
    tot_idx = ri()
    rows.append([
        Paragraph("Total cost per garment", s_tot),
        "", "", "",
        Paragraph(f'{d["total_cost"]:,.2f}', s_tot_r),
    ])
    cmds += [
        ("SPAN",          (0, tot_idx), (3, tot_idx)),
        ("TOPPADDING",    (0, tot_idx), (-1, tot_idx), 4),
        ("BOTTOMPADDING", (0, tot_idx), (-1, tot_idx), 4),
        ("LINEBELOW",     (0, tot_idx), (-1, tot_idx), 1.0, RULE_C),
    ]

    # Four pricing rows (right-aligned, 3pt padding)
    divisor_label = f"1.{int(round(d['vat_rate'] * 100)):02d}"  # e.g. 1.16
    pricing = [
        ("Retail price, VAT-inclusive",
         f'{d["retail_incl_vat"]:,.2f}', s_pr, s_pr_r),
        (f'Selling price, ex-VAT (retail \u00f7 {divisor_label})',
         f'{d["selling"]:,.2f}', s_pr, s_pr_r),
        ("Margin per garment",
         f'{d["margin_value"]:,.2f}', s_mg, s_mg_r),
        ("Margin %",
         f'{d["margin_pc"]:.2f}%', s_mg, s_mg_r),
    ]
    for lbl_txt, val_txt, ls, rs in pricing:
        pr_idx = ri()
        rows.append([
            Paragraph(lbl_txt, ls),
            "", "", "",
            Paragraph(val_txt, rs),
        ])
        cmds += [
            ("SPAN",          (0, pr_idx), (3, pr_idx)),
            ("TOPPADDING",    (0, pr_idx), (-1, pr_idx), 3),
            ("BOTTOMPADDING", (0, pr_idx), (-1, pr_idx), 3),
        ]

    # Global style
    cmds += [
        ("LEFTPADDING",  (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("VALIGN",       (0, 0), (-1, -1), "TOP"),
    ]

    tbl = Table(rows, colWidths=col_w, repeatRows=0)
    tbl.setStyle(TableStyle(cmds))

    return [tbl, Spacer(0, 12)]


def _section_signoff(d: dict) -> list:
    signoffs  = d.get("signoffs", [])
    n         = len(signoffs)
    if not n:
        return []
    tile_w    = CW / n

    cells = []
    for so in signoffs:
        signed = bool(so.get("name"))
        fill   = GREEN_BG if signed else PANEL
        rc     = GREEN_TX if signed else MUTED
        name   = so.get("name") or "\u2014"
        ts     = so.get("signed_at") or "\u2014"
        note   = name if signed else "Awaiting signature"

        content = [
            Paragraph(
                f'<font name="Helvetica" size="7.5" color="{hx(rc)}">{so["role"]}</font>',
                _ps(7.5, 10, rc),
            ),
            Spacer(0, 3),
            Paragraph(
                f'<font name="Helvetica-Bold" size="8.5" color="{hx(rc)}">{note}</font>',
                _ps(8.5, 11, rc, bold=True),
            ),
            Spacer(0, 2),
            Paragraph(
                f'<font name="Helvetica" size="7.5" color="{hx(rc)}">{ts}</font>',
                _ps(7.5, 10, rc),
            ),
        ]
        cells.append(content)

    tbl = Table([cells], colWidths=[tile_w] * n)
    style_cmds = [
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 10),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 10),
        ("TOPPADDING",    (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        *[("LINEAFTER",    (i, 0), (i, 0), 2, WHITE) for i in range(n - 1)],
        *[("BOX",          (i, 0), (i, 0), 0.5, HAIR) for i in range(n)],
        *[("BACKGROUND",   (i, 0), (i, 0),
           GREEN_BG if signoffs[i].get("name") else PANEL)
          for i in range(n)],
    ]
    tbl.setStyle(TableStyle(style_cmds))

    return [tbl, Spacer(0, 10)]


def _section_notes(d: dict) -> list:
    basis_lbl = Paragraph(
        f'<font name="Helvetica-Bold" size="7.5" color="{hx(MUTED)}">BASIS OF COSTING</font>',
        _ps(7.5, 10, MUTED, bold=True),
    )
    basis_body = Paragraph(
        f'<font name="Helvetica" size="7" color="{hx(MUTED)}">{d.get("basis_note", "")}</font>',
        _ps(7, 9.5, MUTED),
    )

    revisions = d.get("revisions", [])
    rev_markup = "<br/>".join(
        f'<font name="Helvetica" size="7" color="{hx(MUTED)}">{r}</font>'
        for r in revisions
    )
    rev_lbl = Paragraph(
        f'<font name="Helvetica-Bold" size="7.5" color="{hx(MUTED)}">REVISION HISTORY</font>',
        _ps(7.5, 10, MUTED, bold=True),
    )
    rev_body = Paragraph(rev_markup, _ps(7, 9.5, MUTED)) if rev_markup else Paragraph(
        f'<font name="Helvetica" size="7" color="{hx(MUTED)}">\u2014</font>',
        _ps(7, 9.5, MUTED),
    )

    tbl = Table(
        [[
            [basis_lbl, Spacer(0, 3), basis_body],
            [rev_lbl,   Spacer(0, 3), rev_body],
        ]],
        colWidths=[CW * 0.56, CW * 0.44],
    )
    tbl.setStyle(TableStyle([
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 0),
        ("RIGHTPADDING",  (1, 0), (1, 0), 0),
        ("RIGHTPADDING",  (0, 0), (0, 0), 12),
        ("TOPPADDING",    (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))

    hr = HRFlowable(width=CW, thickness=0.5, color=HAIR, spaceAfter=0)
    return [hr, Spacer(0, 7), tbl]


# ── Main entry point ──────────────────────────────────────────────────────────

def build_sheet(data: dict, out_path: str) -> str:
    """
    Render a one-page A4 product costing sheet to *out_path*.
    Returns out_path on success.
    Raises ValueError if derived values are inconsistent.
    Raises RuntimeError if the content does not fit on a single page.
    """
    d    = _derive(data)
    logo = _get_logo()

    story = (
        _section_header(d, logo)
        + _section_identity(d)
        + _section_kpi(d)
        + _section_composition(d)
        + _section_table(d)
        + _section_signoff(d)
        + _section_notes(d)
    )

    def _on_page(canvas, doc):
        _draw_footer(canvas, doc, d)

    frame = Frame(
        MARGIN, BOT_MARGIN, CW, PAGE_H - MARGIN - BOT_MARGIN,
        leftPadding=0, bottomPadding=0, rightPadding=0, topPadding=0,
        id="main",
    )
    template = PageTemplate(id="main", frames=[frame], onPage=_on_page)

    doc = BaseDocTemplate(
        out_path, pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=MARGIN, bottomMargin=BOT_MARGIN,
    )
    doc.addPageTemplates([template])
    doc.build(story)

    # Assert exactly 1 page
    if doc.page != 1:
        raise RuntimeError(
            f"Costing sheet rendered {doc.page} page(s); expected exactly 1. "
            "Reduce line count or tighten spacing."
        )

    return out_path
