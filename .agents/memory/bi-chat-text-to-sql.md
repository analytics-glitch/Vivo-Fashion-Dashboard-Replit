---
name: BI chat assistant (text-to-SQL)
description: How the Vivo BI conversational assistant runs AI-generated SQL safely.
---
The `/api/chat` assistant (api_pg.py) is a flexible read-only text-to-SQL agent, not a canned-response bot. Flow: LLM "plan" pass returns JSON (either a direct answer or ONE SELECT) → SQL executed → LLM "summarize" pass turns rows into plain-text prose.

**Why read-only via a dedicated connection, not the shared pool:** generated SQL is untrusted. It runs on its own `psycopg2.connect(..., options="-c default_transaction_read_only=on -c statement_timeout=8000")` + `set_session(readonly=True)`, never the autocommit pool used by trusted endpoints — so a bad/abusive query can't write, hang, or poison a pooled connection.

**Admin-only tools inside the chat:** tool-level authorization keys off `ctx["_role"]`, which the chat endpoints stamp SERVER-SIDE via `_chat_trusted_ctx()` (strips any client-sent underscore keys, reads role from the authenticated session). Never trust role/permission values in the client context body. Example: `get_page_usage` (page-visit analytics from the `page_visits` table, fed by a best-effort `POST /api/auth/page-visit` on every web route change; page ids whitelisted against the page catalog).

**How to apply / guardrails to keep:** single-statement SELECT/WITH only (reject `;`), keyword denylist, hard row cap, and a PII guard that blocks SQL referencing phone/email unless `pii_revealed(request)`. Uses the Replit OpenAI integration (`AI_INTEGRATIONS_OPENAI_BASE_URL`/`_API_KEY`, model gpt-5.4) — no own key. ChatWidget renders plain text (whitespace-pre-wrap), so the summarizer must emit prose, NOT markdown.
