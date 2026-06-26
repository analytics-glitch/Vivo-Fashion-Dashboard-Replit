#!/usr/bin/env python3
"""Build the retired-styles-to-go-online report.
Reads the uploaded retired list, joins price + online status from the DB,
adds suggested online allocation (min 3, capped at warehouse stock) and bin.
Output: Retired_Styles_Online_Allocation.xlsx
"""
import openpyxl, psycopg2, os
from openpyxl.styles import Font, PatternFill, Alignment

SRC = "Retired_Styles_in_Warehouse__1_.xlsx"   # place this file in the workspace
OUT = "Retired_Styles_Online_Allocation.xlsx"

wb = openpyxl.load_workbook(SRC, data_only=True)
ws1 = wb["Sheet1"]
retired = []   # (style_name, product_name, sku, barcode, wh_qty_from_file, bin)
for r in ws1.iter_rows(min_row=2, values_only=True):
    retired.append({"style_name": r[0], "product_name": r[1], "sku": (str(r[2]).strip() if r[2] else None),
                    "barcode": (str(r[3]).strip() if r[3] is not None else None),
                    "file_qty": r[5], "bin": r[6]})

skus = tuple({x["sku"] for x in retired if x["sku"]})

conn = psycopg2.connect(os.environ["DATABASE_URL"]); cur = conn.cursor()
# price + product name from master
cur.execute("SELECT sku, price, product_name FROM all_products_clean WHERE sku IN %s", (skus,))
master = {s: {"price": p, "pname": n} for s, p, n in cur.fetchall()}
# warehouse available (live) and online available (live)
cur.execute("""SELECT sku, SUM(available) FROM all_inventory
               WHERE pos_location_name='Warehouse Finished Goods' AND sku IN %s GROUP BY sku""", (skus,))
wh_live = {s: q for s, q in cur.fetchall()}
cur.execute("""SELECT sku, SUM(available) FROM all_inventory
               WHERE pos_location_name='Online - Shop Zetu' AND sku IN %s GROUP BY sku""", (skus,))
onl_live = {s: q for s, q in cur.fetchall()}
conn.close()

out = openpyxl.Workbook(); ws = out.active; ws.title = "Retired to Online"
headers = ["Barcode","SKU","Product Name","Style Name","Price (KES)",
           "Warehouse Available","Online Available","Suggested Online Allocation","Bin"]
ws.append(headers)
for c in ws[1]:
    c.font = Font(bold=True, color="FFFFFF"); c.fill = PatternFill("solid", fgColor="1F4E79")
    c.alignment = Alignment(horizontal="center", wrap_text=True)

for x in retired:
    sku = x["sku"]
    m = master.get(sku, {})
    wh = wh_live.get(sku, x["file_qty"] or 0) or 0
    onl = onl_live.get(sku, 0) or 0
    alloc = min(3, int(wh)) if onl == 0 else 0   # only allocate if not already online
    ws.append([x["barcode"], sku, m.get("pname") or x["product_name"], x["style_name"],
               m.get("price"), float(wh), float(onl), alloc, x["bin"]])

widths = [14,18,52,40,12,16,14,16,14]
for i, w in enumerate(widths, start=1):
    ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = w
ws.freeze_panes = "A2"
out.save(OUT)
print(f"Wrote {OUT} with {len(retired)} rows")
print(f"  with price: {sum(1 for x in retired if master.get(x['sku'],{}).get('price') is not None)}")
print(f"  not online (allocatable): {sum(1 for x in retired if (onl_live.get(x['sku'],0) or 0)==0)}")
