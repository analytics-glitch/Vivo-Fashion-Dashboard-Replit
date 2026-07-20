---
name: Retail Desk AI Analyst bugs
description: Five bugs that prevented the first-run structured analysis; each must be avoided when adding new LLM-backed async endpoints.
---

## Rules

**1. HAIKU model constant is `claude-haiku-4-5`, not `claude-haiku-3-5`.**
`retail_desk_router.py` and `ai_insights_router.py` both define a `HAIKU` constant. The correct Anthropic model id is `claude-haiku-4-5` (matches `desk_utils.py`). The dash-separated format `claude-haiku-3-5` is 404.

**Why:** Model name 404 silently falls through to `except Exception: return {}`, producing a blank analysis with no error visible in the HTTP response.

**How to apply:** Any new router that adds its own HAIKU constant must use `claude-haiku-4-5`.

---

**2. Any SQL block that interpolates `BASE_FILTERS` or `_IS_RETAIL` must alias `all_sales` as `s`.**
`BASE_FILTERS` (api_pg.py) uses `s.pos_location_name`, `s.product_title` etc. If the FROM clause reads `FROM all_sales` (no alias), Postgres raises "missing FROM-clause entry for table s".

**Why:** The filter is a raw SQL string injected via f-string, not a parameterized fragment; it always assumes the `s` alias.

**How to apply:** Every query that uses `{bf}` or `{_IS_RETAIL}` must have `FROM all_sales s` (or `JOIN all_sales s ON …`).

---

**3. Blocking LLM/HTTP calls inside `async` FastAPI endpoints must use `asyncio.to_thread`.**
Calling a synchronous function that makes an HTTP request (e.g. `anthropic.messages.create`) directly from an `async def` endpoint blocks uvicorn's single event-loop thread. The endpoint appears to hang and returns an empty body.

**Why:** uvicorn is single-threaded; one blocked coroutine starves all other requests.

**How to apply:**
```python
result = await asyncio.to_thread(blocking_fn, arg1, arg2)
```
`asyncio` must be imported at the top of the module.

---

**4. In LLM JSON schemas, put high-priority fields first.**
The LLM fills output in schema order. If `metric_map` or `data_gaps` appear before `verdict`/`top_action`/`what_working`, and max_tokens is hit, the critical fields are lost. Always place the most important fields at the top of the schema.

**How to apply:** Order: verdict → top_action → what_working → what_misbehaving → signal_vs_noise → opportunity → actions → predictions → metric_map → data_gaps.

---

**5. `max_tokens=3500` is too small for the 6-part structured response; use 4096.**
The full analyst response (3 items × each array, full text fields) exceeds 3500 tokens. The JSON was truncated mid-field, causing a parse failure that silently returned `{}`.

**How to apply:** Use `max_tokens=4096` for the retail desk analyst call.
