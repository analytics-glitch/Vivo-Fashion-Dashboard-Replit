---
name: Recharts donut/pie collapse with bottom legend
description: A Recharts Pie inside ResponsiveContainer can render as a thin line / nothing when a bottom Legend eats the vertical space.
---

# Recharts Pie collapses to a thin line

Symptom: a `<PieChart>` with valid positive data renders nothing (or a thin horizontal line) while a sibling `<LineChart>` in the same grid/layout renders fine. The Legend still shows all series with correct colors (proof the Pie has sectors), but no donut is drawn.

**Cause:** the bottom `<Legend>` consumes the chart's vertical space, so Recharts shrinks the auto-computed Pie radius to ~0. Line/Bar charts are unaffected because they fill width×height and don't need a square.

**Fix:** pin the Pie geometry instead of relying on auto-fit:
- set explicit `cx="50%"` and a `cy` above center (e.g. `cy="42%"`),
- set explicit `innerRadius`/`outerRadius`,
- give `<Legend>` an explicit `height` (e.g. `height={36}`) so it reserves a fixed band,
- `isAnimationActive={false}` also avoids a separate flaky-at-screenshot animation issue.

**How to apply:** whenever adding a donut/pie with a bottom legend in this repo (Recharts v2). Bar/line charts don't need this.
