---
name: Validation agent learned_range false-firing
description: Why the Tier-2 learned_range detector flooded on strong trading days and the consensus/seasonal-PoP/net_comp design that fixed it
---

# Tier-2 learned_range false positives on a strong-but-real day

A single genuinely-strong trading day (record Friday) made the BI data-validation
agent's Tier-2 `learned_range` check fire 100+ findings across nearly every store
and metric. The underlying `all_sales` data was CORRECT (no duplication, single
source, all Tier-1 identities held; `net_sales` is VAT-exclusive by design).

**Root causes (measured):**
- The legacy rule fired on ANY single signal of {z, p1-p99, IQR fence, PoP}. ~70 of
  ~143 findings were **PoP-only**.
- PoP compared to **literally yesterday**, not the same weekday. Retail swings hugely
  across the week, so a Friday after a quiet Thursday is a routine +130% — PoP tripped
  on almost everything.
- `net_comp_residual` is a near-ZERO ratio (already VAT-aware per-row in
  `metrics.expected_net_comp`). Range-checking a ~0 series turns every wiggle into a
  huge z; a PERFECT 0 reconciliation even fired as a "-100% PoP drop".

**The fix (decision):**
1. **Consensus firing** — a finding needs one EXTREME signal (z ≥ `Z_SEVERE`, default 5)
   OR agreement across ≥2 independent signal FAMILIES. p1-p99 and IQR collapse into ONE
   "non-parametric band" family (they're read off the same distribution and move
   together). Toggle via `REQUIRE_CONSENSUS`.
2. **Seasonal + corroboration-only PoP** — compare to the most recent same-(dow,promo)
   value, require ≥ `MIN_BUCKET_POINTS` seasonal history, and PoP can only confirm a
   distribution anomaly, never raise one alone.
3. **net_comp_residual gate** — skip when `abs(residual) <= NET_COMP_TOL`; material
   composition breaks are already caught by the Tier-1 `net_composition` identity at the
   same tolerance.

**Why this is safe:** a clean row-doubling (which leaves abv/asp/msi ratios intact so
Tier-1 can't see it) trips z + band + PoP together → still fires. A record-but-consistent
day only nudges the band → stays quiet. Result on the reproduction day: 143→20 findings,
16→8 RED, survivors all multi-signal (e.g. ASP z=-5.7+band).

**How to apply:** when the agent floods on a busy day, the data is usually fine — check
Tier-1 first (identities), and tune the Tier-2 knobs in `validation_agent/config.py`
(`Z_SEVERE`, `REQUIRE_CONSENSUS`, `POP_CAP`, `MIN_BUCKET_POINTS`), don't touch BI sales calc.
