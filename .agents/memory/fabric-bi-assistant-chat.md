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

## Scope: covers the WHOLE fabric BI surface
The schema doc (`_FABRIC_CHAT_SCHEMA_DOC`) + prompt (`_fabric_chat_system_prompt`) ground EVERY fabric tab, not just stock/ageing/consumption: suppliers & PO performance, production/BOM & where-used, buying-team reservations, attribute explorer, data quality, plus audit/reconcile questions. The doc carries the exact dashboard derivations (supplier outstanding = Σ(ordered−received)×price_unit; fill_rate, lead days, overdue from po-performance; fabric kg/style from BOM uom kg/g; open reservations = status='active'; MO-missing-conversion treats NULL kpm as missing). **Why:** the agent must reconcile with the on-screen tab, so its SQL must match each endpoint's SQL exactly. Two extra tables are documented for the agent: `fabric_reservations` (app-owned, lazily created) and `mo_fabric_consumption`. It still refuses non-fabric questions and stays read-only via `run_readonly_sql`.

## Frontend
- The widget is **vanilla JS/CSS injected into `fabric_dashboard_live.html`** (the page is static, served by api_pg's catch-all — no React). It mirrors the React `ChatWidget.jsx` SSE parsing.
- Uses **separate** localStorage keys `vivo_fabric_chat_session_id` / `vivo_fabric_chat_log_v1` so it never collides with the main BI assistant's history.
- **XSS:** all model/user text is rendered via `textContent` (never innerHTML) — do not switch to string-templated innerHTML for chat bubbles (see `fabric-dashboard-xss.md`).
- Context sent each turn: `location` (#location-filter), `date_from`/`date_to` (#g-since/#g-until) or `days` (#mix-period), and `scope` (active `.nav-item[data-page]` → `support` when on Support Fabrics, else `main`).

## Attachments (fabric chat only — main chat unchanged)
- Image + text-file attachments are a **fabric-only** feature. `_chat_agent_events` gained optional `user_content`/`history_text` params; when present, the user turn is sent to the LLM as multi-part content but only a compact `[attached: a.png, b.csv]` placeholder is stored in session history (cheap + keeps later-turn guards intact). Main `ChatWidget.jsx` / `/api/chat` deliberately pass neither, so they're byte-for-byte unchanged.
- `_chat_prepare_user_turn(message, attachments)` returns `(user_content, history_text, error)` — `(None,None,None)` when no attachments (falls back to the plain string path). Images → `image_url` data-URL parts (vision); CSV/TXT/JSON/MD/TSV → inline text; PDF → `pypdf` text extract (scanned PDFs yield a "no extractable text" note, never raise). Caps mirrored client+server: 4 files, 8 MB each, 16 MB total, 20k chars/file.
- Frontend stages files (paperclip button + paste + drag-drop) and sends `attachments:[{name,mime,data:dataURL}]`. **localStorage persists only `{name,mime,isImage}`** — never the base64 — so reloaded image bubbles degrade to a filename chip. Rendered user-bubble text still uses `textContent` (in a child div, so the attachment thumbnails aren't wiped).
