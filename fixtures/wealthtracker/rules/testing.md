# Testing — Focus Areas

Project-specific testing conventions added to the Testing agent's universal checks.

- **Pure-function unit tests are the dominant pattern.** Extract logic out of components into plain functions and test them directly — e.g. `equityFillPct` is exported and unit-tested in `EquityBar.test.tsx` rather than asserting on rendered DOM. Domain math (`src/lib/networth`, `src/lib/allocation`, `src/lib/projections`, `src/lib/dividends`, XIRR/`tax`, `src/lib/spend`, `src/lib/cards`) should live in testable functions
- **Vitest is the test runner.** Import explicitly: `import { describe, it, expect, vi } from 'vitest'`. Use `vi.fn`, `vi.mock`, `vi.spyOn`. The `@` alias resolves to `./src` in tests
- **Mock external boundaries at the module level with `vi.mock`** — Supabase clients (`src/lib/supabase/{client,server,admin}.ts`), Plaid (`src/lib/plaid`), Stripe (`src/lib/stripe`), Resend (`src/lib/email`), and Anthropic (`src/lib/claude`). Mock the module, not ad-hoc `global.fetch`/`window.fetch`
- **Time-dependent tests use fake timers** — `vi.useFakeTimers()` + `vi.setSystemTime(...)`; never rely on real system time. Prefer `date-fns` over raw `new Date()` inside the logic under test so behavior is deterministic
- **Test file colocation** — test files live next to the source under test (`Foo.test.ts` alongside `Foo.ts`, `Foo.test.tsx` alongside the component), not in a separate `__tests__/` tree (except shared test utilities)
- **Edge case coverage** — every new test should exercise: empty, zero / one / many, boundary values, and at least one happy path. For investing surfaces, cover the since-purchase gain path (the project convention), not day-change
- **Error path testing** — not just happy paths. Test validation failures (zod schema rejections), rejected promises, and the error branches of domain functions
- **No React rendering harness yet** — there is currently no `@testing-library/react` in the repo. Prefer testing extracted logic. If component DOM tests are genuinely needed, they require adding a rendering harness first; don't assume one exists
- **Keep tests green** — `yarn test` (vitest run), `yarn typecheck`, and `yarn lint` must all pass; no `any` in test types
