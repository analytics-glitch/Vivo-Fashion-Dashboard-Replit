#!/usr/bin/env python3
"""Standalone FastAPI service for the production tracker (port 8002)."""

import os
import logging
from typing import Optional

import psycopg2
from psycopg2.extras import RealDictCursor
from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from fastapi.responses import JSONResponse
from security_config import cors_config, fastapi_docs_config, internal_token_valid

DATABASE_URL = os.environ["DATABASE_URL"]
PORT = int(os.environ.get("PRODUCTION_API_PORT", "8002"))
log = logging.getLogger("production_api")

router = APIRouter(prefix="/api/production", tags=["production"])


def get_conn():
    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)


@router.get("/health")
def health():
    try:
        conn = get_conn()
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        conn.close()
        return {"status": "ok"}
    except Exception:
        log.exception("production API health check failed")
        raise HTTPException(503, "service unavailable")


@router.get("/stages")
def list_stages():
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT s.stage_key, s.stage_name, s.sort_order,
                       s.is_terminal, s.allowed_next,
                       COALESCE(w.orders_here, 0)          AS orders_here,
                       COALESCE(w.units_here, 0)           AS units_here,
                       COALESCE(w.avg_days_in_stage, 0)    AS avg_days_in_stage,
                       COALESCE(w.oldest_days_in_stage, 0) AS oldest_days_in_stage
                FROM production_stages s
                LEFT JOIN v_wip_summary w ON w.stage = s.stage_key
                ORDER BY s.sort_order
            """)
            return {"stages": cur.fetchall()}
    finally:
        conn.close()


@router.get("/board")
def board():
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT b.order_ref, b.stage, b.qty_here,
                       ROUND(b.days_since_last_in::numeric, 1) AS days_in_stage,
                       po.style_number, po.style_name, po.product_name,
                       po.order_qty, po.date_ordered, po.expected_delivery_date,
                       po.buyer
                FROM v_stage_balances b
                JOIN production_orders po ON po.order_ref = b.order_ref
                JOIN production_stages s   ON s.stage_key  = b.stage
                ORDER BY s.sort_order, b.days_since_last_in DESC
            """)
            return {"cards": cur.fetchall()}
    finally:
        conn.close()


@router.get("/orders/{order_ref}")
def order_detail(order_ref: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM production_orders WHERE order_ref = %s", (order_ref,)
            )
            order = cur.fetchone()
            if not order:
                raise HTTPException(404, f"Order {order_ref} not found")

            cur.execute(
                """
                SELECT colour, product_sku, product_name, total_qty,
                       planned_qty, remaining_qty, line_state
                FROM production_order_lines
                WHERE order_ref = %s
                ORDER BY total_qty DESC
            """,
                (order_ref,),
            )
            lines = cur.fetchall()

            cur.execute(
                """
                SELECT b.stage, s.stage_name, b.qty_here,
                       ROUND(b.days_since_last_in::numeric, 1) AS days_in_stage
                FROM v_stage_balances b
                JOIN production_stages s ON s.stage_key = b.stage
                WHERE b.order_ref = %s
                ORDER BY s.sort_order
            """,
                (order_ref,),
            )
            balances = cur.fetchall()

            cur.execute(
                """
                SELECT from_stage, to_stage, qty, moved_at, moved_by, note
                FROM stage_movements
                WHERE order_ref = %s
                ORDER BY moved_at DESC, id DESC
            """,
                (order_ref,),
            )
            history = cur.fetchall()

        return {
            "order": order,
            "lines": lines,
            "balances": balances,
            "history": history,
        }
    finally:
        conn.close()


class MoveIn(BaseModel):
    order_ref: str
    from_stage: str
    to_stage: str
    qty: float = Field(gt=0)
    moved_by: Optional[str] = None
    note: Optional[str] = None


@router.post("/move")
def move(m: MoveIn):
    if m.from_stage == m.to_stage:
        raise HTTPException(400, "from_stage and to_stage are the same")
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT allowed_next FROM production_stages WHERE stage_key = %s",
                    (m.from_stage,),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(400, f"Unknown stage: {m.from_stage}")
                if m.to_stage not in (row["allowed_next"] or []):
                    raise HTTPException(
                        400, f"Cannot move from {m.from_stage} to {m.to_stage}"
                    )
                cur.execute(
                    """
                    SELECT qty_here FROM v_stage_balances
                    WHERE order_ref = %s AND stage = %s
                """,
                    (m.order_ref, m.from_stage),
                )
                bal = cur.fetchone()
                available = float(bal["qty_here"]) if bal else 0.0
                if m.qty > available:
                    raise HTTPException(
                        400, f"Only {available:g} units available at {m.from_stage}"
                    )
                cur.execute(
                    """
                    INSERT INTO stage_movements
                        (order_ref, from_stage, to_stage, qty, moved_by, note)
                    VALUES (%s, %s, %s, %s, %s, %s)
                """,
                    (m.order_ref, m.from_stage, m.to_stage, m.qty, m.moved_by, m.note),
                )
    finally:
        conn.close()
    return order_detail(m.order_ref)


app = FastAPI(title="Vivo Production Tracker API", **fastapi_docs_config())
app.add_middleware(CORSMiddleware, **cors_config())
app.include_router(router)


@app.middleware("http")
async def standalone_auth_gate(request: Request, call_next):
    if request.method == "OPTIONS":
        return await call_next(request)
    path = request.url.path
    if path.startswith("/api/production/") and path != "/api/production/health":
        if not internal_token_valid(request):
            return JSONResponse({"detail": "Not authenticated"}, status_code=401)
    return await call_next(request)


@app.get("/")
def root():
    return {"service": "production-tracker"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
