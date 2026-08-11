# Standards — Checklist

Every item here is mandatory. The Standards agent must report compliance per item.

**Exports & Naming**

- [ ] **Named exports preferred** — favor `export const ComponentName = () => {}` over `export default` for components, hooks, and libs (App Router `page.tsx`/`layout.tsx`/`error.tsx` may default-export per framework requirement)
- [ ] **File naming** — components PascalCase (`Foo.tsx`), App Router special files lowercase (`page.tsx`, `layout.tsx`, `route.ts`, `error.tsx`), tests colocated as `Foo.test.{ts,tsx}`
- [ ] **Hook names** — must start with `use` and live in `src/components/shared/` (reusable) or next to the component (feature-specific)
- [ ] **`@` import alias** — use `@/...` (maps to `./src`) for cross-feature imports rather than deep relative paths

**TypeScript**

- [ ] No `any` types in new code (use `unknown` + narrowing, or proper generics)
- [ ] No `@ts-ignore` / `@ts-expect-error` without an inline comment explaining why
- [ ] No non-null assertions (`!`) on values that could legitimately be null — prefer explicit null checks
- [ ] Prefer zod-inferred types (`z.infer<typeof schema>`) over hand-maintained duplicate interfaces

**Forms**

- [ ] Forms use react-hook-form + zod via `zodResolver` — no ad-hoc `useState` form state for anything beyond trivial single-field inputs
- [ ] Every client-side zod schema is mirrored by server-side validation in the route handler (don't rely on client-only validation)
- [ ] Submit buttons are `disabled` while `formState.isSubmitting` is true

**Data**

- [ ] React Query mutations invalidate (`invalidateQueries`) or update (`setQueryData`) the affected cache so the UI reflects the change
- [ ] `queryKey`s are stable and descriptive, scoped to the resource and its inputs
- [ ] Supabase queries rely on RLS / ownership scoping — never assume the client filter is the authorization boundary; the `admin.ts` service-role client must never reach the client bundle
- [ ] Investing surfaces lead with since-purchase gain, never daily / day-change (project convention)

**Dates**

- [ ] Use `date-fns` for date math and formatting — no raw `new Date()` inside calculations (allocation, projections, XIRR, dividends, tax, spend)

**Testing**

- [ ] Every new lib function, hook, and non-trivial component has a colocated `*.test.{ts,tsx}`
- [ ] Prefer pure-function unit tests — extract logic into testable functions and assert directly (e.g. `equityFillPct` in `EquityBar.test.tsx`)
- [ ] Tests use Vitest (`import { describe, it, expect, vi } from 'vitest'`); use `vi.fn` / `vi.mock` / `vi.useFakeTimers` for isolation
- [ ] No `any` in test types — type mocks against the real function / module signatures

**Code Quality**

- [ ] Passes `yarn lint`, `yarn typecheck`, and `yarn prettier:check`
- [ ] No debug output (`console.log`, `console.debug`, `debugger`, `// TODO` without a GitHub issue reference)
- [ ] No unused imports or variables
- [ ] No commented-out code blocks (delete, don't comment)
- [ ] No empty `catch {}` blocks that swallow errors silently
