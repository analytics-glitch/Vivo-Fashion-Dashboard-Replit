---
name: Gemini image generation from Python
description: Quirks of calling the Replit AI-Integrations Gemini image endpoint (gemini-2.5-flash-image) directly over REST from Python.
---

Calling `{AI_INTEGRATIONS_GEMINI_BASE_URL}/models/gemini-2.5-flash-image:generateContent` with header `x-goog-api-key` from Python:

- **`"role": "user"` is REQUIRED** on the contents entry. Omitting it returns 400. Body shape: `contents: [{role: "user", parts: [{text}, {inline_data: {mime_type, data}}, ...]}]` — multiple inline images (person + garment) in one parts list works.
- **Response part key is camelCase `inlineData`** even though the request uses snake_case `inline_data`. Parse BOTH keys when extracting the image from `candidates[0].content.parts`.
- Typical latency ~8–10s, output ~1MB PNG for a two-image virtual try-on composite.

**Why:** cost a smoke-test cycle to discover; the asymmetric casing is easy to re-trip on.
**How to apply:** any direct REST Gemini image call (image editing, try-on, composites) — no SDK needed, `requests` is enough.
