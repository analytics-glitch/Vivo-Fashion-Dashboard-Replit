---
name: net_composition VAT + returns conventions
description: Why the validation agent's net_composition check must use a per-row 4-way proximity, not a single net=gross-disc-ret identity.
---

`all_sales` mixes TWO orthogonal conventions that NO column cleanly keys, so a single
composition identity false-fires on most stores/group.

- **VAT basis varies per row:** in-store (Odoo/POS) rows store gross VAT-INCLUSIVE
  (`net = (gross-disc)/(1+VAT)`); Online + named-Kenya rows store gross VAT-EXCLUSIVE
  (`net = gross-disc`). Only `net = total/(1+VAT)` holds universally (that's the
  separate `vat_reconciliation` check, tight everywhere).
- **Returns vary per row:** in-store returns are SEPARATE rows (`net=0`, amount in
  `returns_kes`) so subtracting returns DOUBLE-counts them; Online/ShopifyQL returns
  are already netted into `net_sales` as a signed total, so there returns ARE part of
  composition.

**Rule:** `expected_net_comp` is a per-row SQL pick of the candidate closest to that
row's net among `{g-d-r, (g-d-r)/(1+VAT), g-d, (g-d)/(1+VAT)}`, summed at native row
grain (so mixed aggregates stay correct), compared via `_rel` vs `NET_COMP_TOL`.

**Why:** confirmed by the prod findings' own diagnosis (e.g. in-store order gross=6900
net=5948.28 → /1.16; Online gross=net=5948.28, total=6900 → raw). 4-way took
complete-day fires 57→0, group 0.18–0.39%, while a synthetic +50% net break still fires.

**Masking caveat:** because expected anchors on the row's own net, a source-wide drift
that merely SWITCHES among these four sanctioned conventions is absorbed and won't fire
here — that class is still caught by `vat_reconciliation` (net vs total/1.16).

**learned_range partial-day:** tier-2 must evaluate only COMPLETED days. Anchor the
window at `eval_end = d1 - 1`, not today, else the partial current day is scored against
a full-day learned range (was the 169-finding root cause). Live runs use
`evaluate_days=1`, so a naive "skip today" would disable tier2 — use the explicit
`eval_start..eval_end` window instead.
