"""Atelier alterations backend.

The module deliberately owns only atelier workflow data.  Customers remain in
``all_customers`` and staff identities remain in ``app_users``.
"""
import io
import json
import pathlib
import re
import secrets
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from html import escape

from fastapi import File, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, Response

A = None

STATUSES = ("intake", "fitting", "in_progress", "quality_check", "ready", "collected", "cancelled")
TRANSITIONS = {
    "intake": {"fitting", "in_progress", "cancelled"},
    "fitting": {"in_progress", "cancelled"},
    "in_progress": {"fitting", "quality_check", "cancelled"},
    "quality_check": {"in_progress", "ready", "cancelled"},
    "ready": {"collected", "in_progress", "cancelled"},
    "collected": set(),
    "cancelled": set(),
}
MAX_PHOTO = 8 * 1024 * 1024
ALLOWED_IMAGES = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}
POLICY_KEY = "garment_alterations_policy"
POLICY_TITLE = "Vivo Garment Alterations Policy — June 2026"
POLICY_TEXT = pathlib.Path(__file__).with_name("atelier_policy_june_2026.txt").read_text(encoding="utf-8")


def normalize_kenyan_phone(value):
    """Return strict Kenyan E.164 mobile format, or raise ValueError."""
    raw = str(value or "").strip()
    digits = re.sub(r"\D", "", raw)
    if digits.startswith("00254"):
        digits = digits[2:]
    if digits.startswith("254"):
        national = digits[3:]
    elif digits.startswith("0"):
        national = digits[1:]
    else:
        national = digits
    if len(national) != 9 or national[0] not in {"1", "7"}:
        raise ValueError("Enter a valid Kenyan mobile number")
    return "+254" + national


def validate_status_transition(old, new):
    if old not in TRANSITIONS or new not in TRANSITIONS:
        raise ValueError("Invalid atelier status")
    if new == old:
        raise ValueError("Job is already in that status")
    if new not in TRANSITIONS[old]:
        raise ValueError(f"Cannot move a job from {old} to {new}")
    return True


def validate_measurement(name, value, unit="cm"):
    name = str(name or "").strip()
    unit = str(unit or "cm").strip().lower()
    if not name or len(name) > 80:
        raise ValueError("Measurement name is required and must be at most 80 characters")
    if unit not in {"cm", "in", "mm"}:
        raise ValueError("Measurement unit must be cm, in, or mm")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, TypeError):
        raise ValueError("Measurement value must be numeric")
    if not number.is_finite() or number <= 0 or number > 1000:
        raise ValueError("Measurement value must be between 0 and 1000")
    return name, number, unit


def _money(value, field="charge"):
    if value in (None, ""):
        return Decimal("0.00")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, TypeError):
        raise HTTPException(400, f"{field} must be numeric")
    if not number.is_finite() or number < 0 or number > Decimal("10000000"):
        raise HTTPException(400, f"{field} must be between 0 and 10000000")
    return number.quantize(Decimal("0.01"))


def _timestamp(value, field="promised_at"):
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
        except (TypeError, ValueError):
            raise HTTPException(400, f"{field} must be an ISO-8601 date and time")
    if parsed.year < 2000 or parsed.year > 2200:
        raise HTTPException(400, f"{field} is outside the supported date range")
    return parsed


def _text(value, field, maximum, required=False):
    value = str(value or "").strip()
    if required and not value:
        raise HTTPException(400, f"{field} is required")
    if len(value) > maximum:
        raise HTTPException(400, f"{field} must be at most {maximum} characters")
    return value or None


def _db(sql, params=None, fetch=True):
    return A._users_exec(sql, params, fetch=fetch)


def _actor(request):
    user = getattr(request.state, "user", None) or {}
    if not user or user.get("status") != "active":
        raise HTTPException(401, "Not authenticated")
    return user


def _staff(request, admin=False):
    user = _actor(request)
    role = str(user.get("role") or "").lower()
    if admin and role != "admin":
        raise HTTPException(403, "Administrator access required")
    pages = user.get("allowed_pages")
    if pages is None and A is not None:
        pages = A._effective_pages_for_role(role)
        effective = {"allowed_pages": pages, "extra_pages": user.get("extra_pages") or []}
        A._apply_extra_pages(effective)
        pages = effective["allowed_pages"]
    if "atelier" not in (pages or []):
        raise HTTPException(403, "Atelier page access required")
    if role == "admin":
        return user
    uid = str(user.get("user_id") or user.get("id") or "")
    rows = _db("SELECT active FROM atelier_staff WHERE user_id=%s", (uid,)) or []
    if not rows or not rows[0]["active"]:
        raise HTTPException(403, "Atelier staff access required")
    return user


def _uid(user):
    return str(user.get("user_id") or user.get("id"))


def atelier_user_enabled(user_id, role):
    """Safe entitlement lookup for shared identity responses.

    This is intentionally tolerant of a deployment where the deferred Atelier
    schema initializer has not run yet: auth identity must never fail because a
    feature table is absent.
    """
    if str(role or "").lower() == "admin":
        return True
    if not user_id or A is None:
        return False
    try:
        rows = A._users_exec(
            "SELECT active FROM atelier_staff WHERE user_id=%s", (str(user_id),), fetch=True) or []
        return bool(rows and rows[0].get("active"))
    except Exception:
        return False


def _row(row):
    out = dict(row)
    for key, value in list(out.items()):
        if isinstance(value, (datetime, date)):
            out[key] = value.isoformat()
        elif isinstance(value, Decimal):
            out[key] = float(value)
        elif isinstance(value, memoryview):
            out.pop(key)
    return out


def _mask(rows, request, phones=("phone",), emails=("email",)):
    """Use the platform reveal-token protocol, never a bespoke Atelier mask."""
    return A.mask_pii_rows(rows, request, phone_keys=phones, email_keys=emails)


def _pricing_enabled():
    try:
        rows = _db("SELECT value FROM atelier_config WHERE key='pricing_enabled'") or []
        value = rows[0].get("value") if rows else False
        return bool(value.get("enabled")) if isinstance(value, dict) else bool(value)
    except Exception:
        return False


def ensure_atelier_tables():
    """Idempotent, additive DDL. Existing configuration is never overwritten."""
    statements = [
        """CREATE TABLE IF NOT EXISTS atelier_locations (
             id BIGSERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
             active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now())""",
        """CREATE TABLE IF NOT EXISTS atelier_config (
             key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
             updated_by TEXT)""",
        """CREATE TABLE IF NOT EXISTS atelier_policies (
             key TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
             active BOOLEAN NOT NULL DEFAULT TRUE, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
             updated_by TEXT)""",
        """CREATE TABLE IF NOT EXISTS atelier_policy_versions (
             id BIGSERIAL PRIMARY KEY, policy_key TEXT NOT NULL, version INTEGER NOT NULL,
             title TEXT NOT NULL, body TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
             created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
             UNIQUE(policy_key,version))""",
        """CREATE TABLE IF NOT EXISTS atelier_staff (
             user_id TEXT PRIMARY KEY REFERENCES app_users(user_id) ON DELETE CASCADE,
             active BOOLEAN NOT NULL DEFAULT TRUE, added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
             added_by TEXT)""",
        """CREATE TABLE IF NOT EXISTS atelier_alteration_types (
             id BIGSERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
             description TEXT, active BOOLEAN NOT NULL DEFAULT TRUE,
             price_kes NUMERIC(14,2) NOT NULL DEFAULT 0, pricing_active BOOLEAN NOT NULL DEFAULT FALSE,
             created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
             updated_by TEXT)""",
        "CREATE SEQUENCE IF NOT EXISTS atelier_claim_seq",
        """CREATE TABLE IF NOT EXISTS atelier_jobs (
             id BIGSERIAL PRIMARY KEY, claim_number TEXT NOT NULL UNIQUE,
             customer_id TEXT NOT NULL, customer_store_id TEXT NOT NULL,
             location_id BIGINT NOT NULL REFERENCES atelier_locations(id),
             garment_index INTEGER NOT NULL DEFAULT 1, garment_type TEXT NOT NULL,
             sku TEXT, product_name TEXT, colour TEXT, size TEXT,
             alteration_notes TEXT, promised_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'intake',
             service_charge NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(service_charge >= 0),
             amount_paid NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(amount_paid >= 0),
             assigned_to TEXT REFERENCES app_users(user_id) ON DELETE SET NULL,
             created_by TEXT NOT NULL REFERENCES app_users(user_id),
             created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
             completed_at TIMESTAMPTZ, CHECK(status IN ('intake','fitting','in_progress',
             'quality_check','ready','collected','cancelled')))""",
        "ALTER TABLE atelier_jobs ADD COLUMN IF NOT EXISTS condition_notes TEXT",
        "ALTER TABLE atelier_jobs ADD COLUMN IF NOT EXISTS alteration_type_id BIGINT REFERENCES atelier_alteration_types(id)",
        "ALTER TABLE atelier_jobs ADD COLUMN IF NOT EXISTS source_system TEXT",
        "ALTER TABLE atelier_jobs ADD COLUMN IF NOT EXISTS source_identity TEXT",
        "ALTER TABLE atelier_jobs ADD COLUMN IF NOT EXISTS source_row TEXT",
        "ALTER TABLE atelier_jobs ADD COLUMN IF NOT EXISTS historical_customer_name TEXT",
        "ALTER TABLE atelier_jobs ADD COLUMN IF NOT EXISTS historical_phone TEXT",
        "ALTER TABLE atelier_jobs ADD COLUMN IF NOT EXISTS service_type TEXT",
        "ALTER TABLE atelier_jobs ADD COLUMN IF NOT EXISTS date_in TIMESTAMPTZ",
        "ALTER TABLE atelier_jobs ADD COLUMN IF NOT EXISTS collected_at TIMESTAMPTZ",
        "ALTER TABLE atelier_jobs ADD COLUMN IF NOT EXISTS legacy_notes TEXT",
        "ALTER TABLE atelier_jobs ADD COLUMN IF NOT EXISTS garment_category TEXT",
        "ALTER TABLE atelier_jobs ADD COLUMN IF NOT EXISTS garment_subcategory TEXT",
        "ALTER TABLE atelier_jobs ADD COLUMN IF NOT EXISTS system_description TEXT",
        """CREATE TABLE IF NOT EXISTS atelier_measurements (
             id BIGSERIAL PRIMARY KEY, job_id BIGINT NOT NULL REFERENCES atelier_jobs(id) ON DELETE CASCADE,
             name TEXT NOT NULL, value NUMERIC(10,2) NOT NULL CHECK(value > 0), unit TEXT NOT NULL DEFAULT 'cm',
             note TEXT, recorded_by TEXT NOT NULL REFERENCES app_users(user_id),
             recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK(unit IN ('cm','in','mm')))""",
        """CREATE TABLE IF NOT EXISTS atelier_customer_measurements (
             id BIGSERIAL PRIMARY KEY, customer_id TEXT NOT NULL, customer_store_id TEXT NOT NULL,
             name TEXT NOT NULL, value NUMERIC(10,2) NOT NULL CHECK(value > 0),
             unit TEXT NOT NULL DEFAULT 'cm', note TEXT,
             recorded_by TEXT NOT NULL REFERENCES app_users(user_id),
             recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK(unit IN ('cm','in','mm')))""",
        """CREATE TABLE IF NOT EXISTS atelier_status_history (
             id BIGSERIAL PRIMARY KEY, job_id BIGINT NOT NULL REFERENCES atelier_jobs(id) ON DELETE CASCADE,
             from_status TEXT, to_status TEXT NOT NULL, note TEXT,
             changed_by TEXT NOT NULL REFERENCES app_users(user_id),
             changed_at TIMESTAMPTZ NOT NULL DEFAULT now())""",
        """CREATE TABLE IF NOT EXISTS atelier_edit_history (
             id BIGSERIAL PRIMARY KEY, job_id BIGINT NOT NULL REFERENCES atelier_jobs(id) ON DELETE CASCADE,
             changes JSONB NOT NULL, edited_by TEXT NOT NULL REFERENCES app_users(user_id),
             edited_at TIMESTAMPTZ NOT NULL DEFAULT now())""",
        """CREATE TABLE IF NOT EXISTS atelier_photos (
             id BIGSERIAL PRIMARY KEY, job_id BIGINT NOT NULL REFERENCES atelier_jobs(id) ON DELETE CASCADE,
             content BYTEA NOT NULL, content_type TEXT NOT NULL, byte_size INTEGER NOT NULL,
             caption TEXT, uploaded_by TEXT NOT NULL REFERENCES app_users(user_id),
             uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now())""",
        "CREATE INDEX IF NOT EXISTS idx_atelier_jobs_board ON atelier_jobs(location_id,status,promised_at)",
        "CREATE INDEX IF NOT EXISTS idx_atelier_jobs_customer ON atelier_jobs(customer_id,customer_store_id,created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_atelier_measurements_job ON atelier_measurements(job_id,recorded_at DESC)",
        """CREATE INDEX IF NOT EXISTS idx_atelier_customer_measurements
           ON atelier_customer_measurements(customer_id,customer_store_id,recorded_at DESC)""",
        "CREATE INDEX IF NOT EXISTS idx_atelier_status_job ON atelier_status_history(job_id,changed_at)",
        """CREATE UNIQUE INDEX IF NOT EXISTS uq_atelier_jobs_source
           ON atelier_jobs(source_system,source_identity,source_row)
           WHERE source_system IS NOT NULL AND source_identity IS NOT NULL AND source_row IS NOT NULL""",
    ]
    for statement in statements:
        _db(statement, fetch=False)
    _db("ALTER TABLE atelier_alteration_types ADD COLUMN IF NOT EXISTS price_kes NUMERIC(14,2) NOT NULL DEFAULT 0", fetch=False)
    _db("ALTER TABLE atelier_alteration_types ADD COLUMN IF NOT EXISTS pricing_active BOOLEAN NOT NULL DEFAULT FALSE", fetch=False)
    _db("""INSERT INTO atelier_locations(code,name) VALUES ('junction','Junction Mall')
           ON CONFLICT(code) DO NOTHING""", fetch=False)
    _db("""INSERT INTO atelier_alteration_types(code,name,description,price_kes,pricing_active) VALUES
           ('hemming','Hemming','Hemming (pants, skirts, dresses)',0,FALSE),
           ('sleeve_shortening','Sleeve shortening','Sleeve shortening',0,FALSE),
           ('waist_adjustment','Waist adjustment','Waist adjustment (minor)',0,FALSE),
           ('tapering','Tapering','Tapering (basic fit adjustment)',0,FALSE),
           ('minor_repairs','Minor repairs','Minor repairs (buttons, seams)',0,FALSE)
           ON CONFLICT(code) DO NOTHING""", fetch=False)
    defaults = {
        "default_location": {"code": "junction"},
        "ticket": {"currency": "KES", "footer": "Please present this ticket when collecting your garment."},
        "workflow": {"statuses": list(STATUSES)},
    }
    for key, value in defaults.items():
        _db("INSERT INTO atelier_config(key,value) VALUES (%s,%s::jsonb) ON CONFLICT(key) DO NOTHING",
            (key, json.dumps(value)), fetch=False)
    _db("""INSERT INTO atelier_config(key,value) VALUES
           ('junction_tailor_mapping',%s::jsonb)
           ON CONFLICT(key) DO NOTHING""",
        (json.dumps({"display_name": "Maximillia Kubochi", "app_user_id": None,
                     "location_code": "junction"}),), fetch=False)
    _db("""INSERT INTO atelier_policies(key,title,body,active)
           VALUES (%s,%s,%s,TRUE) ON CONFLICT(key) DO NOTHING""",
        (POLICY_KEY, POLICY_TITLE, POLICY_TEXT), fetch=False)
    _db("""INSERT INTO atelier_policy_versions(policy_key,version,title,body,active)
           VALUES (%s,1,%s,%s,TRUE) ON CONFLICT(policy_key,version) DO NOTHING""",
        (POLICY_KEY, POLICY_TITLE, POLICY_TEXT), fetch=False)


def _customer_by_phone(phone):
    rows = _db("""
        SELECT customer_id,store_id,first_name,last_name,email,phone,city,country
        FROM all_customers
        WHERE regexp_replace(COALESCE(phone,''),'[^0-9]','','g') IN (%s,%s,%s)
        ORDER BY CASE WHEN store_id='vivofashiongroup' THEN 0 ELSE 1 END,last_synced DESC NULLS LAST,
                 customer_id,store_id
        LIMIT 20
    """, (phone[1:], "0" + phone[4:], phone[4:])) or []
    return [_row(r) for r in rows]


def _customer_search(query, limit=25):
    """Search the shared customer master without choosing a row for the user."""
    query = str(query or "").strip()
    if not query:
        return []
    digits = re.sub(r"\D", "", query)
    phone_variants = {digits}
    if digits.startswith("00254"):
        phone_variants.add(digits[2:])
    if digits.startswith("254"):
        phone_variants.add("0" + digits[3:])
        phone_variants.add(digits[3:])
    elif digits.startswith("0"):
        phone_variants.add("254" + digits[1:])
        phone_variants.add(digits[1:])
    else:
        phone_variants.add("254" + digits)
        phone_variants.add("0" + digits)
    phone_variants = tuple(v for v in phone_variants if v)
    phone_sql = " OR ".join(
        ["regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=%s"] * len(phone_variants)
    ) or "FALSE"
    params = list(phone_variants)
    text = "%" + query + "%"
    params.extend([text] * 4)
    rows = _db(f"""
        SELECT customer_id,store_id,first_name,last_name,email,phone,city,country
        FROM all_customers
        WHERE ({phone_sql}
          OR COALESCE(first_name,'') ILIKE %s
          OR COALESCE(last_name,'') ILIKE %s
          OR COALESCE(email,'') ILIKE %s
          OR COALESCE(customer_id,'') ILIKE %s)
        ORDER BY
          CASE
            WHEN customer_id ILIKE %s THEN 0
            WHEN email ILIKE %s THEN 1
            WHEN regexp_replace(COALESCE(phone,''),'[^0-9]','','g') = ANY(%s) THEN 2
            WHEN first_name ILIKE %s OR last_name ILIKE %s THEN 3
            ELSE 4
          END,
          CASE WHEN store_id='vivofashiongroup' THEN 0 ELSE 1 END,
          last_synced DESC NULLS LAST, customer_id, store_id
        LIMIT %s
    """, tuple(params[:len(phone_variants)] + [text] * 4 +
               [text, text, list(phone_variants), text, text, limit])) or []
    return [_row(r) for r in rows]


def _customer(customer_id, store_id):
    rows = _db("""SELECT customer_id,store_id,first_name,last_name,email,phone,city,country
                  FROM all_customers WHERE customer_id=%s AND store_id=%s""",
               (customer_id, store_id)) or []
    if not rows:
        raise HTTPException(404, "Customer not found")
    return rows[0]


def _job(job_id, lock=False, cursor=None):
    sql = """SELECT j.*,l.code AS location_code,l.name AS location_name,
                    u.name AS assigned_to_name
             FROM atelier_jobs j JOIN atelier_locations l ON l.id=j.location_id
             LEFT JOIN app_users u ON u.user_id=j.assigned_to WHERE j.id=%s"""
    if lock:
        sql += " FOR UPDATE OF j"
    if cursor:
        cursor.execute(sql, (job_id,))
        row = cursor.fetchone()
    else:
        rows = _db(sql, (job_id,)) or []
        row = rows[0] if rows else None
    if not row:
        raise HTTPException(404, "Atelier job not found")
    return row


def _photo_bytes(data, declared):
    if not data:
        raise HTTPException(400, "Empty file")
    if len(data) > MAX_PHOTO:
        raise HTTPException(413, "Photo must be at most 8 MB")
    if declared not in ALLOWED_IMAGES:
        raise HTTPException(415, "Only JPEG, PNG, and WebP photos are allowed")
    try:
        from PIL import Image, ImageOps
        Image.MAX_IMAGE_PIXELS = 25_000_000
        probe = Image.open(io.BytesIO(data))
        actual = probe.format
        probe.verify()
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image)
        if image.width < 1 or image.height < 1 or image.width * image.height > 25_000_000:
            raise ValueError("unsafe dimensions")
        image.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
        # Re-encoding drops EXIF and any embedded payload. PNG retains alpha;
        # all other accepted inputs are normalized to JPEG.
        output = io.BytesIO()
        if actual == "PNG" and image.mode in ("RGBA", "LA"):
            image.save(output, "PNG", optimize=True)
            declared = "image/png"
        else:
            image.convert("RGB").save(output, "JPEG", quality=88, optimize=True)
            declared = "image/jpeg"
        data = output.getvalue()
    except Exception:
        raise HTTPException(400, "Invalid or corrupt image")
    if actual not in ALLOWED_IMAGES.values():
        raise HTTPException(400, "Photo content does not match its media type")
    return data, declared


def register_atelier_routes(app, api_module=None):
    global A
    if api_module is None:
        import api_pg as api_module
    A = api_module

    @app.get("/api/atelier/customers/lookup")
    def customer_lookup(request: Request, phone: str = None, q: str = None, limit: int = 25):
        _staff(request)
        query = (q if q is not None else phone) or ""
        if len(str(query).strip()) < 2:
            return {"customers": []}
        limit = min(max(int(limit), 1), 50)
        if q is not None or not re.fullmatch(r"[\s+\-()0-9]{5,}", str(query)):
            return {"customers": _mask(_customer_search(query, limit), request, phones=("phone",))}
        try:
            normalized = normalize_kenyan_phone(query)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"customers": _mask(_customer_by_phone(normalized)[:limit], request)}

    @app.post("/api/atelier/customers")
    async def customer_create(request: Request):
        _staff(request)
        body = await request.json()
        try:
            phone = normalize_kenyan_phone(body.get("phone"))
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        first = _text(body.get("first_name"), "first_name", 100, True)
        last = _text(body.get("last_name"), "last_name", 100)
        email = _text(body.get("email"), "email", 254)
        if email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise HTTPException(400, "Invalid email address")
        city = _text(body.get("city"), "city", 100)
        # Serialize atelier creates for a normalized number.  all_customers is a
        # shared imported master and cannot safely gain a globally unique phone
        # constraint, so this advisory lock prevents duplicate desk entry.
        with A._users_tx() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("atelier:" + phone,))
            cur.execute("""SELECT customer_id,store_id,first_name,last_name,email,phone,city,country
                           FROM all_customers
                           WHERE regexp_replace(COALESCE(phone,''),'[^0-9]','','g')
                             IN (%s,%s,%s)
                           ORDER BY CASE WHEN store_id='vivofashiongroup' THEN 0 ELSE 1 END,
                                    last_synced DESC NULLS LAST LIMIT 1""",
                        (phone[1:], "0" + phone[4:], phone[4:]))
            existing = cur.fetchone()
            if existing:
                return {"created": False, "customer": _mask([_row(existing)], request)[0]}
            customer_id = "atelier-" + secrets.token_hex(12)
            store_id = "vivofashiongroup"
            cur.execute("""INSERT INTO all_customers
                (customer_id,store_id,first_name,last_name,email,phone,city,country,
                 customer_type,total_orders,total_spend_kes,avg_order_value_kes,last_synced)
                VALUES (%s,%s,%s,%s,%s,%s,%s,'Kenya','New',0,0,0,now())
                RETURNING customer_id,store_id,first_name,last_name,email,phone,city,country""",
                (customer_id, store_id, first, last, email, phone, city))
            created = cur.fetchone()
        return {"created": True, "customer": _mask([_row(created)], request)[0]}

    @app.get("/api/atelier/skus")
    def sku_search(request: Request, q: str, limit: int = 20):
        _staff(request)
        q = _text(q, "q", 100, True)
        limit = min(max(limit, 1), 50)
        like = "%" + q + "%"
        rows = _db("""SELECT sku,product_name,barcode,size,color_print AS colour,
                       style_number,style_name,product_type AS garment_subcategory,
                       category AS garment_category,product_name AS system_description
                      FROM all_products_clean
                      WHERE sku ILIKE %s OR barcode ILIKE %s OR style_number ILIKE %s
                         OR style_name ILIKE %s OR product_name ILIKE %s
                         OR category ILIKE %s OR product_type ILIKE %s
                      ORDER BY CASE
                        WHEN LOWER(sku)=LOWER(%s) THEN 0
                        WHEN LOWER(barcode)=LOWER(%s) THEN 1
                        WHEN LOWER(style_number)=LOWER(%s) THEN 2
                        WHEN LOWER(style_name)=LOWER(%s) THEN 3
                        ELSE 4 END,
                        sku LIMIT %s""",
                   (like, like, like, like, like, like, like,
                    q, q, q, q, limit)) or []
        return {"items": [_row(r) for r in rows]}

    @app.post("/api/atelier/intake")
    async def intake(request: Request):
        user = _staff(request)
        body = await request.json()
        customer_id = _text(body.get("customer_id"), "customer_id", 200, True)
        store_id = _text(body.get("customer_store_id") or body.get("store_id"),
                         "customer_store_id", 100, True)
        _customer(customer_id, store_id)
        garments = body.get("garments")
        if not isinstance(garments, list) or not 1 <= len(garments) <= 25:
            raise HTTPException(400, "garments must contain between 1 and 25 items")
        location = _text(body.get("location_code") or "junction", "location_code", 50, True)
        created = []
        with A._users_tx() as cur:
            cur.execute("SELECT id FROM atelier_locations WHERE code=%s AND active", (location,))
            loc = cur.fetchone()
            if not loc:
                raise HTTPException(400, "Invalid or inactive atelier location")
            for index, garment in enumerate(garments, 1):
                if not isinstance(garment, dict):
                    raise HTTPException(400, "Each garment must be an object")
                garment_category = _text(
                    garment.get("garment_category") or garment.get("garment_type"),
                    "garment_category", 100)
                garment_subcategory = _text(
                    garment.get("garment_subcategory") or garment.get("subcategory"),
                    "garment_subcategory", 150)
                system_description = _text(
                    garment.get("system_description") or garment.get("product_name"),
                    "system_description", 300)
                sku = _text(garment.get("sku"), "sku", 100)
                # Catalogue data is snapshotted server-side. Free-typed garments
                # remain supported for historical/manual intake compatibility.
                if sku:
                    cur.execute("""SELECT sku,product_name,size,color_print,product_type,
                                          category,style_number,style_name
                                   FROM all_products_clean WHERE sku=%s
                                   ORDER BY sku LIMIT 1""", (sku,))
                    product = cur.fetchone()
                    if product:
                        garment_category = product["category"] or garment_category
                        garment_subcategory = product["product_type"] or garment_subcategory
                        system_description = product["product_name"] or system_description
                        sku = product["sku"]
                        product_name = product["product_name"]
                        colour = product["color_print"]
                        size = product["size"]
                    else:
                        product_name = system_description
                        colour = _text(garment.get("colour"), "colour", 100)
                        size = _text(garment.get("size"), "size", 50)
                else:
                    product_name = system_description
                    colour = _text(garment.get("colour"), "colour", 100)
                    size = _text(garment.get("size"), "size", 50)
                if not garment_category:
                    raise HTTPException(400, "garment_category is required")
                charge = _money(garment.get("service_charge"))
                paid = _money(garment.get("amount_paid"), "amount_paid")
                if (charge or paid) and not _pricing_enabled():
                    raise HTTPException(400, "Pricing is not enabled for Atelier")
                if paid > charge:
                    raise HTTPException(400, "amount_paid cannot exceed service_charge")
                promised_at = _timestamp(garment.get("promised_at") or body.get("promised_at"))
                assigned_to = garment.get("assigned_to") or None
                if assigned_to:
                    cur.execute("""SELECT 1 FROM app_users u LEFT JOIN atelier_staff s ON s.user_id=u.user_id
                                   WHERE u.user_id=%s AND u.status='active'
                                   AND (u.role='admin' OR s.active)""", (str(assigned_to),))
                    if not cur.fetchone():
                        raise HTTPException(400, "assigned_to must be an active Atelier user")
                alteration_type_id = garment.get("alteration_type_id")
                if alteration_type_id:
                    cur.execute("SELECT 1 FROM atelier_alteration_types WHERE id=%s AND active",
                                (alteration_type_id,))
                    if not cur.fetchone():
                        raise HTTPException(400, "alteration_type_id must be active")
                cur.execute("SELECT nextval('atelier_claim_seq') AS n")
                claim = f"ATJ-{datetime.utcnow().year}-{int(cur.fetchone()['n']):07d}"
                cur.execute("""INSERT INTO atelier_jobs
                    (claim_number,customer_id,customer_store_id,location_id,garment_index,
                     garment_type,garment_category,garment_subcategory,system_description,
                     sku,product_name,colour,size,alteration_notes,condition_notes,alteration_type_id,promised_at,
                     service_charge,amount_paid,assigned_to,created_by)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                    (claim, customer_id, store_id, loc["id"], index, garment_category,
                     garment_category, garment_subcategory, system_description,
                     sku, product_name, colour, size,
                     _text(garment.get("alteration_notes"), "alteration_notes", 4000),
                     _text(garment.get("condition_notes"), "condition_notes", 2000), alteration_type_id,
                     promised_at, charge, paid, assigned_to, _uid(user)))
                row = cur.fetchone()
                cur.execute("""INSERT INTO atelier_status_history
                    (job_id,from_status,to_status,note,changed_by)
                    VALUES (%s,NULL,'intake','Garment received',%s)""", (row["id"], _uid(user)))
                for measurement in garment.get("measurements") or []:
                    try:
                        name, value, unit = validate_measurement(
                            measurement.get("name"), measurement.get("value"), measurement.get("unit"))
                    except (ValueError, AttributeError) as exc:
                        raise HTTPException(400, str(exc))
                    cur.execute("""INSERT INTO atelier_measurements(job_id,name,value,unit,note,recorded_by)
                        VALUES (%s,%s,%s,%s,%s,%s)""",
                        (row["id"], name, value, unit,
                         _text(measurement.get("note"), "measurement note", 500), _uid(user)))
                created.append(_row(row))
        return {"jobs": created, "count": len(created)}

    @app.get("/api/atelier/board")
    def board(request: Request, location_code: str = "junction", status: str = None):
        _staff(request)
        params = [location_code]
        where = "l.code=%s"
        if status:
            if status not in STATUSES:
                raise HTTPException(400, "Invalid status")
            where += " AND j.status=%s"
            params.append(status)
        rows = _db(f"""SELECT j.id,j.claim_number,j.garment_type,j.product_name,j.sku,j.status,
                       j.alteration_notes,j.promised_at,j.created_at,j.updated_at,j.assigned_to,u.name assigned_to_name,
                       COALESCE(NULLIF(concat_ws(' ',c.first_name,c.last_name),''),j.historical_customer_name) customer_name,
                       COALESCE(c.phone,j.historical_phone) customer_phone
                       FROM atelier_jobs j JOIN atelier_locations l ON l.id=j.location_id
                       LEFT JOIN app_users u ON u.user_id=j.assigned_to
                       LEFT JOIN all_customers c ON c.customer_id=j.customer_id AND c.store_id=j.customer_store_id
                       WHERE {where} ORDER BY j.promised_at NULLS LAST,j.created_at""", tuple(params)) or []
        return {"columns": list(STATUSES), "jobs": _mask([_row(r) for r in rows], request,
                                                           phones=("customer_phone",), emails=())}

    @app.get("/api/atelier/jobs/{job_id}")
    def detail(job_id: int, request: Request):
        _staff(request)
        job = _job(job_id)
        try:
            customer = _customer(job["customer_id"], job["customer_store_id"])
            customer = _row(customer)
        except HTTPException:
            customer = {"customer_id": job["customer_id"], "store_id": job["customer_store_id"],
                        "first_name": job.get("historical_customer_name"), "phone": job.get("historical_phone"),
                        "historical": True}
        measurements = _db("SELECT * FROM atelier_measurements WHERE job_id=%s ORDER BY recorded_at,id",
                           (job_id,)) or []
        history = _db("""SELECT h.*,u.name AS changed_by_name FROM atelier_status_history h
                         LEFT JOIN app_users u ON u.user_id=h.changed_by
                         WHERE job_id=%s ORDER BY changed_at,id""", (job_id,)) or []
        edits = _db("SELECT * FROM atelier_edit_history WHERE job_id=%s ORDER BY edited_at,id",
                    (job_id,)) or []
        photos = _db("""SELECT id,caption,content_type,byte_size,uploaded_at
                        FROM atelier_photos WHERE job_id=%s ORDER BY uploaded_at,id""", (job_id,)) or []
        return {"job": _row(job), "customer": _mask([customer], request)[0],
                "measurements": [_row(r) for r in measurements],
                "status_history": [_row(r) for r in history],
                "edit_history": [_row(r) for r in edits], "photos": [_row(r) for r in photos]}

    @app.patch("/api/atelier/jobs/{job_id}")
    async def edit(job_id: int, request: Request):
        user = _staff(request)
        body = await request.json()
        allowed = {
            "garment_type": (100, True), "sku": (100, False), "product_name": (300, False),
            "garment_category": (100, False), "garment_subcategory": (150, False),
            "system_description": (300, False),
            "colour": (100, False), "size": (50, False), "alteration_notes": (4000, False),
            "condition_notes": (2000, False), "alteration_type_id": (None, False),
            "assigned_to": (200, False), "promised_at": (None, False),
            "service_charge": (None, False), "amount_paid": (None, False),
            "status": (None, False), "status_note": (1000, False),
        }
        unknown = set(body) - set(allowed)
        if unknown or not body:
            raise HTTPException(400, "No editable fields supplied")
        with A._users_tx() as cur:
            old = _job(job_id, True, cur)
            changes, sets, params = {}, [], []
            for key, value in body.items():
                if key in {"status", "status_note"}:
                    continue
                if key in {"service_charge", "amount_paid"}:
                    value = _money(value, key)
                elif key == "promised_at":
                    value = _timestamp(value)
                else:
                    value = _text(value, key, allowed[key][0], allowed[key][1])
                if key == "assigned_to" and value:
                    cur.execute("""SELECT 1 FROM app_users u LEFT JOIN atelier_staff s ON s.user_id=u.user_id
                                   WHERE u.user_id=%s AND u.status='active' AND (u.role='admin' OR s.active)""", (value,))
                    if not cur.fetchone():
                        raise HTTPException(400, "assigned_to must be an active Atelier user")
                if key == "alteration_type_id" and value:
                    cur.execute("SELECT 1 FROM atelier_alteration_types WHERE id=%s AND active", (value,))
                    if not cur.fetchone():
                        raise HTTPException(400, "alteration_type_id must be active")
                if old.get(key) != value:
                    changes[key] = {"from": str(old.get(key)) if old.get(key) is not None else None,
                                    "to": str(value) if value is not None else None}
                    sets.append(key + "=%s")
                    params.append(value)
            resulting_charge = body.get("service_charge", old["service_charge"])
            resulting_paid = body.get("amount_paid", old["amount_paid"])
            if Decimal(str(resulting_paid)) > Decimal(str(resulting_charge)):
                raise HTTPException(400, "amount_paid cannot exceed service_charge")
            if (Decimal(str(resulting_paid)) or Decimal(str(resulting_charge))) and not _pricing_enabled():
                raise HTTPException(400, "Pricing is not enabled for Atelier")
            new_status = body.get("status")
            if new_status:
                try:
                    validate_status_transition(old["status"], str(new_status))
                except ValueError as exc:
                    raise HTTPException(409, str(exc))
                changes["status"] = {"from": old["status"], "to": str(new_status)}
                sets.extend(["status=%s", "completed_at=CASE WHEN %s THEN now() ELSE NULL END"])
                params.extend([str(new_status), str(new_status) in {"collected", "cancelled"}])
            if not changes and not new_status:
                return {"job": _row(old), "changed": False}
            params.append(job_id)
            cur.execute("UPDATE atelier_jobs SET " + ",".join(sets) +
                        ",updated_at=now() WHERE id=%s RETURNING *", tuple(params))
            updated = cur.fetchone()
            cur.execute("""INSERT INTO atelier_edit_history(job_id,changes,edited_by)
                           VALUES (%s,%s::jsonb,%s)""",
                        (job_id, json.dumps(changes), _uid(user)))
            if new_status:
                cur.execute("""INSERT INTO atelier_status_history(job_id,from_status,to_status,note,changed_by)
                               VALUES (%s,%s,%s,%s,%s)""",
                            (job_id, old["status"], str(new_status),
                             _text(body.get("status_note"), "status_note", 1000), _uid(user)))
        return {"job": _row(updated), "changed": True}

    @app.post("/api/atelier/jobs/{job_id}/status")
    async def status_change(job_id: int, request: Request):
        user = _staff(request)
        body = await request.json()
        new = str(body.get("status") or "").strip()
        note = _text(body.get("note"), "note", 1000)
        with A._users_tx() as cur:
            old = _job(job_id, True, cur)
            try:
                validate_status_transition(old["status"], new)
            except ValueError as exc:
                raise HTTPException(409, str(exc))
            completed = new in {"collected", "cancelled"}
            cur.execute("""UPDATE atelier_jobs SET status=%s,updated_at=now(),
                           completed_at=CASE WHEN %s THEN now() ELSE NULL END
                           WHERE id=%s RETURNING *""", (new, completed, job_id))
            updated = cur.fetchone()
            cur.execute("""INSERT INTO atelier_status_history
                           (job_id,from_status,to_status,note,changed_by)
                           VALUES (%s,%s,%s,%s,%s)""",
                        (job_id, old["status"], new, note, _uid(user)))
        return {"job": _row(updated)}

    @app.post("/api/atelier/jobs/{job_id}/measurements")
    async def measurement_add(job_id: int, request: Request):
        user = _staff(request)
        _job(job_id)
        body = await request.json()
        try:
            name, value, unit = validate_measurement(body.get("name"), body.get("value"), body.get("unit"))
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        rows = _db("""INSERT INTO atelier_measurements(job_id,name,value,unit,note,recorded_by)
                      VALUES (%s,%s,%s,%s,%s,%s) RETURNING *""",
                   (job_id, name, value, unit, _text(body.get("note"), "note", 500), _uid(user))) or []
        return {"measurement": _row(rows[0])}

    @app.post("/api/atelier/jobs/{job_id}/photos")
    async def photo_upload(job_id: int, request: Request, file: UploadFile = File(...)):
        user = _staff(request)
        _job(job_id)
        declared = (file.content_type or "").lower()
        data = await file.read(MAX_PHOTO + 1)
        data, declared = _photo_bytes(data, declared)
        caption = _text(request.query_params.get("caption"), "caption", 200)
        rows = _db("""INSERT INTO atelier_photos
                      (job_id,content,content_type,byte_size,caption,uploaded_by)
                      VALUES (%s,%s,%s,%s,%s,%s)
                      RETURNING id,job_id,content_type,byte_size,caption,uploaded_at""",
                   (job_id, data, declared, len(data), caption, _uid(user))) or []
        return {"photo": _row(rows[0])}

    @app.get("/api/atelier/photos/{photo_id}")
    def photo_get(photo_id: int, request: Request):
        _staff(request)
        rows = _db("SELECT content,content_type FROM atelier_photos WHERE id=%s", (photo_id,)) or []
        if not rows:
            raise HTTPException(404, "Photo not found")
        return Response(bytes(rows[0]["content"]), media_type=rows[0]["content_type"],
                        headers={"Cache-Control": "private, max-age=300",
                                 "X-Content-Type-Options": "nosniff"})

    @app.get("/api/atelier/jobs/{job_id}/ticket", response_class=HTMLResponse)
    def ticket(job_id: int, request: Request):
        _staff(request)
        job = _job(job_id)
        try:
            customer = _customer(job["customer_id"], job["customer_store_id"])
            name = " ".join(filter(None, [customer.get("first_name"), customer.get("last_name")]))
        except HTTPException:
            name = job.get("historical_customer_name") or "Customer"
        ticket_rows = _db("SELECT value FROM atelier_config WHERE key='ticket'") or []
        ticket_value = ticket_rows[0].get("value") if ticket_rows else {}
        if isinstance(ticket_value, str):
            try:
                ticket_value = json.loads(ticket_value)
            except (TypeError, ValueError):
                ticket_value = {}
        footer = (ticket_value or {}).get(
            "footer", "Please present this ticket when collecting your garment.")
        html = f"""<!doctype html><html><head><meta charset="utf-8"><title>{escape(job['claim_number'])}</title>
        <style>body{{font:16px sans-serif;max-width:650px;margin:32px auto}}h1{{letter-spacing:2px}}
        dl{{display:grid;grid-template-columns:150px 1fr;gap:10px}}@media print{{button{{display:none}}}}</style></head>
        <body><button onclick="print()">Print</button><h1>{escape(job['claim_number'])}</h1>
        <h2>Vivo Atelier · {escape(job['location_name'])}</h2><dl>
        <dt>Customer</dt><dd>{escape(name)}</dd><dt>Garment</dt><dd>{escape(job['garment_type'])}</dd>
        <dt>Alteration</dt><dd>{escape(job.get('alteration_notes') or '—')}</dd>
        <dt>Promised</dt><dd>{escape(str(job.get('promised_at') or 'To be confirmed'))}</dd>
        <dt>Status</dt><dd>{escape(job['status'].replace('_',' ').title())}</dd></dl>
        <p>{escape(str(footer))}</p></body></html>"""
        return HTMLResponse(html, headers={"Cache-Control": "private, no-store",
                                           "X-Frame-Options": "DENY"})

    @app.get("/api/atelier/customers/{customer_id}/history")
    def customer_history(customer_id: str, request: Request, store_id: str = None):
        _staff(request)
        if store_id:
            customer = _customer(customer_id, store_id)
        else:
            customer_rows = _db(
                """SELECT customer_id,store_id,first_name,last_name,email,phone,city,country
                   FROM all_customers WHERE customer_id=%s
                   ORDER BY CASE WHEN store_id='vivofashiongroup' THEN 0 ELSE 1 END
                   LIMIT 1""", (customer_id,)) or []
            if not customer_rows:
                raise HTTPException(404, "Customer not found")
            customer = customer_rows[0]
        identity_params = (customer_id, store_id, store_id)
        rows = _db("""SELECT id,claim_number,garment_type,product_name,status,promised_at,
                      created_at,completed_at FROM atelier_jobs
                      WHERE customer_id=%s
                        AND (%s IS NULL OR customer_store_id=%s)
                      ORDER BY created_at DESC LIMIT 100""", identity_params) or []
        measurements = _db("""SELECT id,name,value,unit,note,recorded_by,recorded_at
                              FROM atelier_customer_measurements
                              WHERE customer_id=%s
                                AND (%s IS NULL OR customer_store_id=%s)
                              ORDER BY recorded_at DESC,id DESC LIMIT 200""",
                           identity_params) or []
        return {"customer": _mask([_row(customer)], request)[0], "jobs": [_row(r) for r in rows],
                "measurements": [_row(r) for r in measurements]}

    @app.post("/api/atelier/customers/{customer_id}/measurements")
    async def customer_measurement_add(customer_id: str, request: Request):
        """Append a reusable customer measurement without requiring a job."""
        user = _staff(request)
        body = await request.json()
        store_id = _text(body.get("store_id") or body.get("customer_store_id") or
                         request.query_params.get("store_id"),
                         "store_id", 100, True)
        _customer(customer_id, store_id)
        try:
            name, value, unit = validate_measurement(body.get("name"), body.get("value"), body.get("unit"))
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        rows = _db("""INSERT INTO atelier_customer_measurements
                      (customer_id,customer_store_id,name,value,unit,note,recorded_by)
                      VALUES (%s,%s,%s,%s,%s,%s,%s)
                      RETURNING id,customer_id,customer_store_id,name,value,unit,note,
                                recorded_by,recorded_at""",
                   (customer_id, store_id, name, value, unit,
                    _text(body.get("note"), "note", 500), _uid(user))) or []
        return {"measurement": _row(rows[0])}

    @app.get("/api/atelier/config")
    def config_get(request: Request):
        user = _staff(request)
        config = _db("SELECT key,value,updated_at FROM atelier_config ORDER BY key") or []
        policy = _db("""SELECT key,title,body,updated_at FROM atelier_policies
                        WHERE active ORDER BY key""") or []
        locations = _db("SELECT id,code,name,active FROM atelier_locations WHERE active ORDER BY name") or []
        types = _db("""SELECT id,code,name,description,active,price_kes,pricing_active
                       FROM atelier_alteration_types WHERE active ORDER BY name""") or []
        staff = _db("""SELECT s.user_id,u.name,u.role
                       FROM atelier_staff s JOIN app_users u ON u.user_id=s.user_id
                       WHERE s.active AND u.status='active' ORDER BY u.name NULLS LAST,u.user_id""") or []
        role = str(user.get("role") or "").lower()
        versions = _db("""SELECT policy_key,version,title,active,created_by,created_at
                           FROM atelier_policy_versions ORDER BY policy_key,version DESC""") or []
        return {"config": [_row(r) for r in config], "policies": [_row(r) for r in policy],
                "locations": [_row(r) for r in locations], "branches": [_row(r) for r in locations],
                "alteration_types": [_row(r) for r in types], "staff": [_row(r) for r in staff],
                "policy_history": [_row(r) for r in versions],
                "authorization": {"atelier_staff": True, "admin": role == "admin",
                                  "can_edit_jobs": True, "can_view_operations": True,
                                  "can_manage_configuration": role == "admin",
                                  "can_view_financials": role == "admin",
                                  "user_id": _uid(user)}}

    @app.put("/api/atelier/admin/config/{key}")
    async def config_put(key: str, request: Request):
        user = _staff(request, admin=True)
        key = _text(key, "key", 80, True)
        body = await request.json()
        if "value" not in body:
            raise HTTPException(400, "value is required")
        _db("""INSERT INTO atelier_config(key,value,updated_at,updated_by)
               VALUES (%s,%s::jsonb,now(),%s) ON CONFLICT(key) DO UPDATE SET
               value=EXCLUDED.value,updated_at=now(),updated_by=EXCLUDED.updated_by""",
            (key, json.dumps(body["value"]), _uid(user)), fetch=False)
        return {"ok": True}

    @app.put("/api/atelier/admin/policies/{key}")
    async def policy_put(key: str, request: Request):
        user = _staff(request, admin=True)
        body = await request.json()
        key = _text(key, "key", 80, True)
        title = _text(body.get("title"), "title", 200, True)
        text = _text(body.get("body"), "body", 100000, True)
        with A._users_tx() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("atelier-policy:" + key,))
            cur.execute("SELECT COALESCE(MAX(version),0)+1 AS version FROM atelier_policy_versions "
                        "WHERE policy_key=%s", (key,))
            version = cur.fetchone()["version"]
            cur.execute("""INSERT INTO atelier_policy_versions
                (policy_key,version,title,body,active,created_by) VALUES (%s,%s,%s,%s,%s,%s)""",
                (key, version, title, text, bool(body.get("active", True)), _uid(user)))
            cur.execute("""INSERT INTO atelier_policies(key,title,body,active,updated_at,updated_by)
                VALUES (%s,%s,%s,%s,now(),%s) ON CONFLICT(key) DO UPDATE SET
                title=EXCLUDED.title,body=EXCLUDED.body,active=EXCLUDED.active,
                updated_at=now(),updated_by=EXCLUDED.updated_by""",
                (key, title, text, bool(body.get("active", True)), _uid(user)))
        return {"ok": True}

    @app.get("/api/atelier/admin/policies/{key}/history")
    def policy_history_get(key: str, request: Request):
        _staff(request, admin=True)
        rows = _db("""SELECT policy_key,version,title,body,active,created_by,created_at
                      FROM atelier_policy_versions WHERE policy_key=%s
                      ORDER BY version DESC""", (key,)) or []
        if not rows:
            raise HTTPException(404, "Policy not found")
        return {"policy_key": key, "versions": [_row(r) for r in rows]}

    @app.put("/api/atelier/admin/staff/{user_id}")
    async def staff_put(user_id: str, request: Request):
        user = _staff(request, admin=True)
        body = await request.json()
        exists = _db("SELECT user_id FROM app_users WHERE user_id=%s AND status='active'", (user_id,)) or []
        if not exists:
            raise HTTPException(404, "Active app user not found")
        _db("""INSERT INTO atelier_staff(user_id,active,added_by) VALUES (%s,%s,%s)
               ON CONFLICT(user_id) DO UPDATE SET active=EXCLUDED.active""",
            (user_id, bool(body.get("active", True)), _uid(user)), fetch=False)
        return {"ok": True}

    @app.get("/api/atelier/admin/staff")
    def staff_admin_list(request: Request):
        """All active users who can be granted Atelier access, including state."""
        _staff(request, admin=True)
        rows = _db("""SELECT u.user_id,u.name,u.email,u.role,
                      COALESCE(s.active,FALSE) AS atelier_enabled
                      FROM app_users u LEFT JOIN atelier_staff s ON s.user_id=u.user_id
                       WHERE u.status='active'
                      ORDER BY u.name NULLS LAST,u.email""",
                   ()) or []
        return {"staff": [_row(r) for r in rows]}

    @app.get("/api/atelier/admin/branches")
    def branches_admin_list(request: Request):
        _staff(request, admin=True)
        rows = _db("SELECT id,code,name,active,created_at FROM atelier_locations ORDER BY name") or []
        return {"branches": [_row(r) for r in rows]}

    @app.post("/api/atelier/admin/branches")
    async def branch_admin_create(request: Request):
        _staff(request, admin=True)
        body = await request.json()
        code = _text(body.get("code"), "code", 50, True)
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", code):
            raise HTTPException(400, "code must contain lowercase letters, numbers, hyphens, or underscores")
        name = _text(body.get("name"), "name", 150, True)
        try:
            rows = _db("""INSERT INTO atelier_locations(code,name,active) VALUES (%s,%s,%s)
                          RETURNING id,code,name,active,created_at""",
                       (code, name, bool(body.get("active", True)))) or []
        except Exception as exc:
            if getattr(exc, "pgcode", None) == "23505":
                raise HTTPException(409, "Branch code already exists")
            raise
        return {"branch": _row(rows[0])}

    @app.patch("/api/atelier/admin/branches/{branch_id}")
    async def branch_admin_update(branch_id: int, request: Request):
        _staff(request, admin=True)
        body = await request.json()
        unknown = set(body) - {"name", "active"}
        if unknown or not body:
            raise HTTPException(400, "Supply name and/or active")
        sets, params = [], []
        if "name" in body:
            sets.append("name=%s")
            params.append(_text(body["name"], "name", 150, True))
        if "active" in body:
            sets.append("active=%s")
            params.append(bool(body["active"]))
        params.append(branch_id)
        rows = _db("UPDATE atelier_locations SET " + ",".join(sets) +
                   " WHERE id=%s RETURNING id,code,name,active,created_at", tuple(params)) or []
        if not rows:
            raise HTTPException(404, "Branch not found")
        return {"branch": _row(rows[0])}

    @app.delete("/api/atelier/admin/branches/{branch_id}")
    def branch_admin_deactivate(branch_id: int, request: Request):
        _staff(request, admin=True)
        rows = _db("""UPDATE atelier_locations SET active=FALSE WHERE id=%s AND active
                      RETURNING id,code,name,active""", (branch_id,)) or []
        if not rows:
            raise HTTPException(404, "Active branch not found")
        return {"branch": _row(rows[0])}

    @app.get("/api/atelier/admin/alteration-types")
    def types_admin_list(request: Request):
        _staff(request, admin=True)
        rows = _db("""SELECT id,code,name,description,active,created_at,updated_at
                      FROM atelier_alteration_types ORDER BY name""") or []
        return {"alteration_types": [_row(r) for r in rows]}

    @app.post("/api/atelier/admin/alteration-types")
    async def type_admin_create(request: Request):
        user = _staff(request, admin=True)
        body = await request.json()
        code = _text(body.get("code"), "code", 50, True)
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", code):
            raise HTTPException(400, "code must contain lowercase letters, numbers, hyphens, or underscores")
        try:
            rows = _db("""INSERT INTO atelier_alteration_types
                          (code,name,description,active,updated_by) VALUES (%s,%s,%s,%s,%s)
                          RETURNING *""",
                       (code, _text(body.get("name"), "name", 150, True),
                        _text(body.get("description"), "description", 1000),
                        bool(body.get("active", True)), _uid(user))) or []
        except Exception as exc:
            if getattr(exc, "pgcode", None) == "23505":
                raise HTTPException(409, "Alteration type code already exists")
            raise
        return {"alteration_type": _row(rows[0])}

    @app.patch("/api/atelier/admin/alteration-types/{type_id}")
    async def type_admin_update(type_id: int, request: Request):
        user = _staff(request, admin=True)
        body = await request.json()
        unknown = set(body) - {"name", "description", "active"}
        if unknown or not body:
            raise HTTPException(400, "Supply name, description, and/or active")
        sets, params = [], []
        for field, maximum in (("name", 150), ("description", 1000)):
            if field in body:
                sets.append(field + "=%s")
                params.append(_text(body[field], field, maximum, field == "name"))
        if "active" in body:
            sets.append("active=%s")
            params.append(bool(body["active"]))
        sets.extend(["updated_at=now()", "updated_by=%s"])
        params.extend([_uid(user), type_id])
        rows = _db("UPDATE atelier_alteration_types SET " + ",".join(sets) +
                   " WHERE id=%s RETURNING *", tuple(params)) or []
        if not rows:
            raise HTTPException(404, "Alteration type not found")
        return {"alteration_type": _row(rows[0])}

    @app.delete("/api/atelier/admin/alteration-types/{type_id}")
    def type_admin_deactivate(type_id: int, request: Request):
        user = _staff(request, admin=True)
        rows = _db("""UPDATE atelier_alteration_types
                      SET active=FALSE,updated_at=now(),updated_by=%s
                      WHERE id=%s AND active RETURNING *""", (_uid(user), type_id)) or []
        if not rows:
            raise HTTPException(404, "Active alteration type not found")
        return {"alteration_type": _row(rows[0])}

    @app.get("/api/atelier/reports/operations")
    def operations_report(request: Request, start: date = None, end: date = None,
                          location_code: str = None):
        """PII-free operational metrics; deliberately excludes every money field."""
        _staff(request)
        start = start or date.today().replace(day=1)
        end = end or date.today()
        if end < start or (end - start).days > 366:
            raise HTTPException(400, "Date range must be at most 366 days")
        location_clause = " AND l.code=%s" if location_code else ""
        params = [start, end]
        if location_code:
            params.append(location_code)
        summary = _db("""SELECT COUNT(*) AS volume,
                   COUNT(*) FILTER (WHERE j.status NOT IN ('collected','cancelled')) AS backlog,
                   COUNT(*) FILTER (WHERE j.status NOT IN ('collected','cancelled')
                     AND j.promised_at < now()) AS overdue,
                   COUNT(*) FILTER (WHERE j.status='collected') AS collected,
                   COUNT(*) FILTER (WHERE j.status='collected' AND j.promised_at IS NOT NULL
                     AND j.completed_at <= j.promised_at) AS collected_on_time,
                   COUNT(*) FILTER (WHERE j.status='cancelled') AS cancelled,
                   COUNT(*) FILTER (WHERE j.assigned_to IS NULL) AS unassigned,
                   COUNT(*) FILTER (WHERE j.promised_at IS NULL) AS missing_promise,
                   COUNT(DISTINCT (j.customer_id,j.customer_store_id)) AS customers
                   FROM atelier_jobs j JOIN atelier_locations l ON l.id=j.location_id
                   WHERE j.created_at >= %s AND j.created_at < (%s::date + INTERVAL '1 day')""" +
                      location_clause, tuple(params)) or []
        by_status = _db("""SELECT j.status,COUNT(*) AS jobs
                           FROM atelier_jobs j JOIN atelier_locations l ON l.id=j.location_id
                           WHERE j.created_at >= %s AND j.created_at < (%s::date + INTERVAL '1 day')""" +
                        location_clause + " GROUP BY j.status ORDER BY j.status", tuple(params)) or []
        by_staff = _db("""SELECT j.assigned_to,u.name,COUNT(*) AS jobs,
                          COUNT(*) FILTER (WHERE j.status NOT IN ('collected','cancelled')) AS backlog
                          FROM atelier_jobs j JOIN atelier_locations l ON l.id=j.location_id
                          LEFT JOIN app_users u ON u.user_id=j.assigned_to
                          WHERE j.created_at >= %s AND j.created_at < (%s::date + INTERVAL '1 day')""" +
                       location_clause + " GROUP BY j.assigned_to,u.name ORDER BY jobs DESC", tuple(params)) or []
        quality = _db("""SELECT COUNT(*) AS quality_checks,
                         COUNT(*) FILTER (WHERE EXISTS (
                           SELECT 1 FROM atelier_status_history h2
                           WHERE h2.job_id=h.job_id AND h2.from_status='quality_check'
                             AND h2.to_status='in_progress')) AS jobs_reworked
                         FROM atelier_status_history h
                         JOIN atelier_jobs j ON j.id=h.job_id
                         JOIN atelier_locations l ON l.id=j.location_id
                         WHERE h.to_status='quality_check' AND h.changed_at >= %s
                           AND h.changed_at < (%s::date + INTERVAL '1 day')""" +
                      location_clause, tuple(params)) or []
        customer = _db("""SELECT COUNT(*) AS customers,
                           COUNT(*) FILTER (WHERE lifetime_jobs > 1) AS repeat_customers
                           FROM (
                             SELECT j.customer_id,j.customer_store_id,
                               (SELECT COUNT(*) FROM atelier_jobs allj
                                WHERE allj.customer_id=j.customer_id
                                  AND allj.customer_store_id=j.customer_store_id) AS lifetime_jobs
                             FROM atelier_jobs j JOIN atelier_locations l ON l.id=j.location_id
                             WHERE j.created_at >= %s
                               AND j.created_at < (%s::date + INTERVAL '1 day')""" +
                       location_clause +
                       " GROUP BY j.customer_id,j.customer_store_id) customer_counts",
                       tuple(params)) or []
        summary_out = _row(summary[0]) if summary else {}
        customer_out = _row(customer[0]) if customer else {}
        collected = int(summary_out.get("collected") or 0)
        on_time = int(summary_out.get("collected_on_time") or 0)
        return {"start": start.isoformat(), "end": end.isoformat(),
                "location_code": location_code, "summary": summary_out,
                "by_status": [_row(r) for r in by_status], "by_staff": [_row(r) for r in by_staff],
                "volume": {"jobs": int(summary_out.get("volume") or 0),
                           "collected": collected,
                           "cancelled": int(summary_out.get("cancelled") or 0)},
                "sla": {"overdue": int(summary_out.get("overdue") or 0),
                        "collected_on_time": on_time,
                        "on_time_rate": round(on_time / collected, 4) if collected else None},
                "backlog": {"jobs": int(summary_out.get("backlog") or 0),
                            "by_status": [_row(r) for r in by_status]},
                "staff": [_row(r) for r in by_staff],
                "quality": _row(quality[0]) if quality else {},
                "customer": customer_out,
                "data_health": {"unassigned": int(summary_out.get("unassigned") or 0),
                                "missing_promise": int(summary_out.get("missing_promise") or 0)}}

    @app.get("/api/atelier/admin/financial-report")
    def financial_report(request: Request, start: date = None, end: date = None):
        _staff(request, admin=True)
        start = start or date.today().replace(day=1)
        end = end or date.today()
        if end < start or (end - start).days > 366:
            raise HTTPException(400, "Date range must be at most 366 days")
        rows = _db("""SELECT l.code,l.name,COUNT(*) AS jobs,
                      COALESCE(SUM(j.service_charge),0) AS charges,
                      COALESCE(SUM(j.amount_paid),0) AS paid,
                      COALESCE(SUM(j.service_charge-j.amount_paid),0) AS balance
                      FROM atelier_jobs j JOIN atelier_locations l ON l.id=j.location_id
                      WHERE j.created_at >= %s AND j.created_at < (%s::date + INTERVAL '1 day')
                      GROUP BY l.code,l.name ORDER BY l.name""", (start, end)) or []
        return {"start": start.isoformat(), "end": end.isoformat(),
                "locations": [_row(r) for r in rows]}
