#!/usr/bin/env python3
"""
production_api.py
-----------------
FastAPI router for the production tracker. Mount in api_pg.py:

    from production_api import router as production_router
    app.include_router(production_router)

Endpoints (all under /api/production):
    GET  /stages              stage reference + live counts (board columns)
    GET  /board               every order's current balance per stage (board cards)
    GET  /orders/{order_ref}  one order: header, balances, full movement history
    POST /move                move a quantity between stages (the board's action)

The move endpoint is the only writer. It validates two things before inserting:
  1. the transition is allowed (to_stage is in from_stage.allowed_next)
  2. there are enough units at from_stage to move
…so the ledger can never go negative or skip stages.
"""

import os
from typing import Optional

import psycopg2
from psycopg2.extras import RealDictCursor
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

DATABASE_URL = os.environ["DATABASE_URL"]

router = APIRouter(prefix="/api/production", tags=["production"])


def get_conn():
    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)


# ----------------------------------------------------------------------
# Reads
# ----------------------------------------------------------------------
@router.get("/stages")
def list_stages():
    """Stage definitions with live order/unit counts — drives the board columns."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT s.stage_key, s.stage_name, s.sort_order,
                       s.is_terminal, s.allowed_next,
                       COALESCE(w.orders_here, 0)        AS orders_here,
                       COALESCE(w.units_here, 0)         AS units_here,
                       COALESCE(w.avg_days_in_stage, 0)  AS avg_days_in_stage,
                       COALESCE(w.oldest_days_in_stage,0) AS oldest_days_in_stage
                FROM production_stages s
                LEFT JOIN v_wip_summary w ON w.stage = s.stage_key
                ORDER BY s.sort_order
            """)
            return {"stages": cur.fetchall()}
    finally:
        conn.close()


@router.get("/board")
def board():
    """Every (order x stage) slice that currently holds units — the board cards."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT b.order_ref,
                       b.stage,
                       b.qty_here,
                       ROUND(b.days_since_last_in::numeric, 1) AS days_in_stage,
                       po.style_number,
                       po.product_name,
                       po.order_qty,
                       po.date_ordered
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
                SELECT b.stage,
                       s.stage_name,
                       b.qty_here,
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

        return {"order": order, "balances": balances, "history": history}
    finally:
        conn.close()


# ----------------------------------------------------------------------
# Write
# ----------------------------------------------------------------------
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
        with conn:  # commits on success, rolls back on raise
            with conn.cursor() as cur:
                # 1. transition allowed?
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

                # 2. enough units at from_stage?
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

                # 3. record the move
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

    # return the order's fresh state so the UI can update in place
    return order_detail(m.order_ref)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Vivo Production Tracker API")
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])
app.include_router(router)


@app.get("/")
def root():
    return {"service": "production-tracker", "docs": "/docs"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0",
                port=int(os.environ.get("PRODUCTION_API_PORT", "8002")))
