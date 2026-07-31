"""
app.py — Flask web wrapper for the Vivo costing sheet PDF generator.

Routes:
    GET  /        — HTML form: paste JSON → download PDF
    POST /render  — JSON body → application/pdf response
"""

import io
import json
import os
import sys

# Ensure the project pythonlibs are importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".pythonlibs", "lib", "python3.11", "site-packages"))

from flask import Flask, request, Response, render_template_string

from costing import build_sheet

app = Flask(__name__)

_FORM_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Vivo · Costing Sheet Generator</title>
  <style>
    body { font-family: Helvetica, Arial, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 20px; color: #1a1a19; }
    h1   { font-size: 18px; margin-bottom: 4px; }
    p    { font-size: 13px; color: #4e4d49; margin-top: 4px; }
    textarea { width: 100%; height: 420px; font-family: monospace; font-size: 12px;
               border: 1px solid #c4c3bc; border-radius: 4px; padding: 10px; box-sizing: border-box; }
    button { margin-top: 12px; padding: 10px 24px; background: #1f5faa; color: #fff;
             border: none; border-radius: 4px; font-size: 14px; cursor: pointer; }
    button:hover { background: #174e8e; }
    .err { color: #c0392b; font-size: 13px; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>Vivo Fashion Group — Costing Sheet</h1>
  <p>Paste a costing JSON payload and click <strong>Generate PDF</strong> to download a print-ready A4 sheet.</p>
  {% if error %}
  <p class="err">⚠ {{ error }}</p>
  {% endif %}
  <form method="POST" action="/render-form">
    <textarea name="payload" spellcheck="false">{{ sample }}</textarea><br>
    <button type="submit">Generate PDF</button>
  </form>
</body>
</html>"""

_SAMPLE = json.dumps({
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
        "CMT is actual labour from the completed DPS divided by 208 garments, "
        "so it moves with order quantity. Retail is the modal SKU price."
    ),
    "signoffs": [
        {"role": "Prepared by",  "name": "Bedan Mwaura",  "signed_at": "29 Jul 2026, 17:22 EAT"},
        {"role": "Checked by",   "name": None,            "signed_at": None},
        {"role": "Approved by",  "name": None,            "signed_at": None}
    ],
    "revisions": [
        "28 Jul 2026, 17:15 — sheet created with 10 lines, Bedan Mwaura",
        "29 Jul 2026, 17:22 — prepared-by signed, step 1 of 3, Bedan Mwaura"
    ],
    "generated_at": "30 Jul 2026, 15:25 EAT"
}, indent=2)


@app.get("/")
def index():
    return render_template_string(_FORM_HTML, sample=_SAMPLE, error=None)


@app.post("/render")
def render():
    """Accept JSON, return application/pdf."""
    try:
        data = request.get_json(force=True)
        if data is None:
            return Response("Invalid JSON body", status=400, mimetype="text/plain")
    except Exception as exc:
        return Response(f"JSON parse error: {exc}", status=400, mimetype="text/plain")

    buf = io.BytesIO()
    tmp = os.path.join("/tmp", f"costing_{os.getpid()}.pdf")
    try:
        build_sheet(data, tmp)
        with open(tmp, "rb") as fh:
            buf.write(fh.read())
    except (ValueError, AssertionError) as exc:
        return Response(f"Validation error: {exc}", status=422, mimetype="text/plain")
    except RuntimeError as exc:
        return Response(f"Layout error: {exc}", status=422, mimetype="text/plain")
    except Exception as exc:
        return Response(f"Render error: {exc}", status=500, mimetype="text/plain")
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass

    buf.seek(0)
    style_no = data.get("style_no", "costing")
    colour   = data.get("colour",   "sheet").replace(" ", "-")
    filename = f"{style_no}-{colour}.pdf"
    return Response(
        buf.read(),
        mimetype="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/render-form")
def render_form():
    """Form POST: parse pasted JSON, return PDF or re-render form with error."""
    payload = request.form.get("payload", "")
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        return render_template_string(_FORM_HTML, sample=payload, error=f"JSON error: {exc}")

    tmp = os.path.join("/tmp", f"costing_{os.getpid()}.pdf")
    try:
        build_sheet(data, tmp)
        with open(tmp, "rb") as fh:
            pdf_bytes = fh.read()
    except (ValueError, AssertionError, RuntimeError, Exception) as exc:
        return render_template_string(_FORM_HTML, sample=payload, error=str(exc))
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass

    style_no = data.get("style_no", "costing")
    colour   = data.get("colour",   "sheet").replace(" ", "-")
    filename = f"{style_no}-{colour}.pdf"
    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5050))
    app.run(host="0.0.0.0", port=port, debug=False)
