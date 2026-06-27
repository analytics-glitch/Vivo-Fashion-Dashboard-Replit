---
name: Fabric BI Assistant chat
description: The /fabric dashboard's floating chat assistant — how it reuses the main chat infra and how it's scoped to fabric data.
---

# Fabric BI Assistant chat

A floating chat widget on the `/fabric` dashboard, scoped to fabric (raw-material) data only.

## Backend (api_pg.py)
- The main chat agent loop `_chat_agent_events` was **parametrized** to accept optional `system_prompt`, `tool_specs`, `dispatch` (defaulting to the main-BI values, so existing callers are unaffected).
- Fabric chat reuses that loop with a fabric-specific system prompt (`_fabric_chat_system_prompt`) + schema doc + a single `run_readonly_sql` tool (the same read-only psycopg2-conn SQL guard as the main chat — see `bi-chat-text-to-sql.md`). Fabric has **no metric-tool functions**, so the agent works purely via read-only SELECT grounded by the schema doc.
- Endpoints: `POST /api/fabric/chat` (blocking) + `POST /api/fabric/chat/stream` (SSE). Both sit behind the standard `clerk_auth_gate` (any authenticated active user — same audience as the fabric page itself; NOT the analyst+ CRM/social gate).

**Why:** keeping the loop shared means one place to maintain the read-only/PII guards; only the prompt + toolset diverge per domain.

## Frontend
- The widget is **vanilla JS/CSS injected into `fabric_dashboard_live.html`** (the page is static, served by api_pg's catch-all — no React). It mirrors the React `ChatWidget.jsx` SSE parsing.
- Uses **separate** localStorage keys `vivo_fabric_chat_session_id` / `vivo_fabric_chat_log_v1` so it never collides with the main BI assistant's history.
- **XSS:** all model/user text is rendered via `textContent` (never innerHTML) — do not switch to string-templated innerHTML for chat bubbles (see `fabric-dashboard-xss.md`).
- Context sent each turn: `location` (#location-filter), `date_from`/`date_to` (#g-since/#g-until) or `days` (#mix-period), and `scope` (active `.nav-item[data-page]` → `support` when on Support Fabrics, else `main`).
