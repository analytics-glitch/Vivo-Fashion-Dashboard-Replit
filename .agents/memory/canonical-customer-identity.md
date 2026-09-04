---
name: Canonical customer identity
description: Durable matching, collision, ambiguity, and publication rules for the shared customer layer.
---

Real customer records may match automatically only through the same normalized phone. Email and name are descriptive evidence, not merge keys. Every source record has a store-qualified source key; bare Shopify customer IDs are never globally unique. A source identity remains durable across rebuild order and later contact edits. Conflicting names on a newly shared phone remain separate and enter review rather than auto-merging. Pseudo accounts retain identities but are excluded from real-person counts.

**Why:** Email/name matching and bare source IDs can attach profiles or sales to the wrong person. Reassigning established IDs during rebuilds also breaks downstream references, while publishing from a partial source snapshot can replace known-good customer data.

**How to apply:** Resolve sales through the qualified system/store/customer key, preserve overrides and review dispositions, publish identity and people atomically only after all expected sources and reconciliation gates pass, and validate changes against disposable PostgreSQL.