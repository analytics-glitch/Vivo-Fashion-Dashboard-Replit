---
name: Async LLM endpoint + BASE_FILTERS alias patterns
description: Durable rules for adding LLM-backed coaching endpoints; covers event-loop safety, SQL alias contract, JSON schema field ordering, and model identifiers.
---

## Rule 1 — Blocking LLM calls inside async endpoints need asyncio.to_thread

Calling any synchronous function that makes an outbound HTTP request (e.g. `anthropic.messages.create`) directly from an `async def` FastAPI handler blocks uvicorn's event loop. The request hangs and returns an empty body; no error appears in the HTTP response.

**Fix:** `result = await asyncio.to_thread(sync_fn, arg1, arg2)` — requires `import asyncio` at module level.

**Why:** uvicorn uses a single-threaded event loop; one blocked coroutine starves every other request.

---

## Rule 2 — Any SQL block that inlines BASE_FILTERS must alias `all_sales` as `s`

`api_pg.BASE_FILTERS` uses `s.pos_location_name`, `s.product_title`, etc. (raw SQL string, no parameterization). A FROM clause of `FROM all_sales` (no alias) makes Postgres raise "missing FROM-clause entry for table s".

**Fix:** `FROM all_sales s` everywhere `{bf}` or `{_IS_RETAIL}` is interpolated.

**Why:** The alias contract is set once in api_pg.py and inherited by every router that uses the filter.

---

## Rule 3 — In LLM JSON schemas, put high-priority fields first

The model fills output in schema order. If low-priority bookkeeping fields (e.g. `metric_map`, `data_gaps`) appear before the business-critical fields (`verdict`, `top_action`, arrays), and `max_tokens` is hit, the critical fields are absent — the parse succeeds but returns nothing useful.

**Fix:** Always order: verdict → top_action → what_working → what_misbehaving → signal_vs_noise → opportunity → actions → predictions → metric_map → data_gaps.

**Why:** Structured outputs with Haiku at 4096 tokens are tight; field order = priority order.

---

## Rule 4 — Correct Anthropic model identifiers for this codebase

| Alias | Correct model id |
|-------|-----------------|
| HAIKU | `claude-haiku-4-5` |
| SONNET | `claude-sonnet-4-5` |

The form `claude-haiku-3-5` returns HTTP 404 from the Anthropic API, which falls through to `except Exception: return {}` — silent blank output.

**Why:** desk_utils.py hard-codes `claude-haiku-4-5`; all routers must match or calls silently fail.

**How to apply:** Use 4096 tokens for full structured retail desk responses; 1400–1500 for digest/flash calls.
