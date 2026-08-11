# Financial Reporting — Focus Areas

HisHarvest calculates and displays personal-wealth aggregations — net worth, investing gains, allocation, projections, dividends, tax, and spend. Display-side miscalculations silently mislead users about their financial position. This agent supplements the generic Data Integrity agent with domain-specific invariants.

**Trigger conditions:**

- Any file under `src/lib/networth/**`, `src/lib/allocation/**`, `src/lib/projections/**`, `src/lib/dividends/**`, `src/lib/tax/**`, `src/lib/billing/**`, or `src/lib/spend/**`
- Any file under `src/components/wealth/**`, `src/components/invest/**`, `src/components/spend/**`, or `src/components/cards/**`
- Diff content contains any of: `amount`, `currency`, `balance`, `total`, `gain`, `costBasis`, `xirr`, `sum(`, `reduce((`, `.toFixed(`, `Math.round(`, `Number(`, `parseFloat(`, `parseInt(` inside any of the above paths

**Focus areas:**

- **Money is never a raw JavaScript `number` for arithmetic.** Check for floating-point arithmetic on money values — any `amount + amount`, `amount * rate`, or `.reduce` accumulating amounts must round only at the display boundary. Flag `.toFixed(n)` used inside aggregation logic.
- **Currency consistency.** Verify no code path sums `amount` across rows that may carry different currencies. Aggregations must resolve to a single reporting currency before summing.
- **Calculation correctness, no drifting duplicates.** XIRR, allocation, projection, dividend, and tax math must be defined once in `src/lib/<domain>/` and reused — flag any duplicate calculation logic across UI layers that could drift.
- **Rounding consistency.** Rounding should happen at the display boundary via `Intl.NumberFormat`, not sprinkled through calculation code.
- **Missing/null amounts.** Balances, gains, and cost bases may be `null` or `undefined`. Verify nullish handling (`?? 0`) where aggregations happen, and that `null` is not silently coerced to `0` where it should surface as "unknown."
- **Date-window correctness.** Reporting windows depend on correct boundaries and inclusive/exclusive semantics — use `date-fns`, not raw `new Date()`. Flag any `new Date()` inside report/calculation logic.
- **Empty-state / zero-state correctness.** A surface with no data should render "no data" — not `$0.00` that looks like a real value.
- **Server/DB aggregations vs client-side summing.** Prefer server- or DB-provided aggregates over client-side `.reduce` when both are available — a client sum over a partial or paginated set is a silent bug.
- **CRITICAL PROJECT RULE — since-purchase, not day-change.** Every investing surface must lead with SINCE-PURCHASE gain, never daily/day-change. Flag any UI that leads with a daily move.

**Output format:** Use the standard agent output format with `Critical Financial Issues`, `Financial Concerns`, `Financial Suggestions`, plus a `Financial Checklist`:

```
### Financial Checklist
- Arithmetic on money values safe: Yes/No/N/A
- Currency consistent across aggregations: Yes/No/N/A
- Rounding at display boundary only: Yes/No/N/A
- Null/undefined amounts handled: Yes/No/N/A
- `date-fns` used for dates (not `new Date()`): Yes/No/N/A
- Since-purchase gain emphasized (not day-change): Yes/No/N/A
- Server/DB aggregations preferred: Yes/No/N/A
```

**Note:** If your analysis determines that the changes do not actually affect financial logic (e.g., the keyword match was a false positive — `amount` could be a form field label), state "No financial calculation code in this PR" clearly and skip the detailed review.
