---
name: Artifact service environments
description: How multi-service web artifacts retain their preview configuration.
---

When a web artifact gains a second managed service, keep the web service's `BASE_PATH` and port environment configuration in the validated artifact TOML; a missing block causes the Vite workflow to fail before it can bind its preview port.

**Why:** The Product Workspace API was healthy while the web workflow failed immediately because the service environment was dropped during a multi-service TOML update.

**How to apply:** Treat the full artifact TOML as the source of truth, validate complete replacements, and restart the affected managed workflow before diagnosing application code.