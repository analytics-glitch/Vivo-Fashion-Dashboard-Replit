---
name: Sublimation costing canon
description: Durable business rules for the Fabric BI sublimation printing costing tab (BOM standard throughput, reprint scope, server recompute).
---

# Sublimation printing costing — canonical rules

## BOM op time = settable STANDARD throughput, never the run's actual rate
The Odoo BOM's operation minutes per kg divide by a settable standard throughput (template
default 60 m/hr, persisted per saved costing); the run's actual m/hr is a display-only
efficiency-variance readout.
**Why:** the exported standard cost must be run-independent — one slow print run must not
change the product's standard cost.
**How to apply:** only the run-costing cards (ink/paper/machine per run) use actual machine
time; anything feeding the BOM/standard cost reads the standard input (fallback 60 when
missing/≤0, FE and BE alike). Regression tests pin both math paths to the template's worked
example.

## Reprint allowance applies to printing lines only
Standard cost = base fabric + (printing lines) × (1 + reprint%). The greige base is never
multiplied by the reprint factor.
**Why:** a reprint consumes ink/paper/machine again, not a second batch of greige.

## Server recomputes every derived figure on save
The save endpoint ignores all client-sent computed fields and re-derives them from inputs via
a pure compute helper shared with the tests; the browser's live math is display-only.
**Why:** a persisted library row must never disagree with the inputs it stores.
**How to apply:** new derived columns go into the compute helper, never straight from the
request body.

## Locked machine-rate constants live in BOTH frontend and backend
Change them together or displayed and stored figures diverge. The rate engine (labour/overhead
pools, utilisation) is deliberately non-editable for now; the calculator opens pre-filled with
the template's worked example so the acceptance figures render on tab open.
