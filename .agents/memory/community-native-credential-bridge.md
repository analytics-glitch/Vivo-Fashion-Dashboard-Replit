---
name: Community native credential bridge
description: Security boundary for the Vivo Johari native WebView shell and its stored Community member token.
---

Store/release builds must hard-lock the Community WebView and native message
bridge to the canonical HTTPS `/app` document origin. Environment URL overrides
are development-only. Bridge messages must be accepted only from the
native-supplied trusted document URL, and stored token values must match the
server-issued token shape.

**Why:** A configurable production WebView origin or an unscoped message bridge
can disclose or replace the bearer token held in platform secure storage even
when ordinary navigation filtering appears correct.

**How to apply:** Treat the bridge as a credential boundary, not a convenience
API. Validate production origin, path, message source, and token format before
any SecureStore read/write; map deep links into the trusted `/app` route rather
than loading their raw URL.