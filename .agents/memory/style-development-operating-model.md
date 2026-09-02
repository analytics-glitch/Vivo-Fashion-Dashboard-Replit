---
name: Style Development operating model
description: Durable readiness, timing, exit, and capacity rules for the Product Development Tracker.
---

Sample fabric selection must use live Fabric BI products. Availability is canonical available stock converted to metres; indicative COGS uses live cost and category-level metres per garment. Adoption readiness is a soft gate: missing stock, season, COGS, price, or a COGS result above 32% of VAT-exclusive selling price requires a recorded override rather than blocking progress absolutely.

**Why:** Product-development decisions need current material feasibility without letting incomplete source data halt urgent work invisibly.

**How to apply:** Keep fabric choice constrained to live products, show the chosen colour plus sibling colours, and preserve structured missing/warning reasons in the API and UI.

Lifecycle reporting uses working days and reports queue, work, and total intervals separately using median, P80, observation count, and standards. Parallel CAD grading and set-sample ordering remain separate branches that converge before production.

**Why:** Calendar-day averages hide weekends, queues, and the actual source of delay.

**How to apply:** Do not collapse queue and work time or replace median/P80 with averages. The happy path is 13 working days while the business target remains 4–5 weeks.

Pattern capacity is data-driven from 3.5 makers, 8.75 patterns per week, and 38 per month, compared with the current approximately 10 weekly adoption target. On-hold and cancelled exits require one exact reason, and the reached stage is frozen at exit time.

**Why:** Queue pressure and fallout need auditable causes and stage attribution rather than hardcoded snapshots.

**How to apply:** Recalculate load from active tracker records. Keep exit reasons limited to pattern will not work, wrong for the season, no fabric in stock, and margin too high.