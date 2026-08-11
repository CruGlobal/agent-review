# Data Integrity — Focus Areas

This is where domain-specific data invariants belong.

- **RLS is the authorization boundary** — every table query must be scoped to the authed household/user. Any new table or column in `supabase/migrations/*.sql` needs a matching RLS policy; a missing or overly broad `using`/`with check` clause leaks data across households. Treat policy changes as high-severity
- **Service-role isolation** — `src/lib/supabase/admin.ts` bypasses RLS and must never reach the client bundle. Flag any import of `admin.ts` from a Client Component or browser path. Prefer `server.ts` in route handlers and Server Components
- **React Query cache updates** — every `useMutation` that changes displayed data must `invalidateQueries` or `setQueryData` on the right `queryKey`, otherwise the UI shows stale data. Verify the key matches the `useQuery` it should refresh
- **Optimistic updates** — must match the server response shape exactly and roll back in `onError` (snapshot in `onMutate`, restore on failure). Adding a list item optimistically must place it in the correct sort position, not just at the end
- **Query key correctness** — keys must include every input that changes the result (filters, household/account id, date range). A key that omits a filter serves stale or cross-scope data from cache
- **Zod at external boundaries** — Plaid, Stripe, Inngest payloads, and request bodies must be validated with `.parse`/`.safeParse` before use. Flag any external JSON consumed without a zod schema, or fields read off an unparsed `any`
- **Sync idempotency** — Plaid and Inngest handlers (`src/lib/plaid`, `src/lib/inngest`) must not double-apply transactions on retry or replay. Verify dedupe on a stable external id and idempotent upserts rather than blind inserts
- **Money precision** — monetary values must not accumulate float drift; round only at the display boundary, never mid-calculation in `src/lib/{networth,allocation,projections,dividends,tax,spend}`. Investing surfaces lead with since-purchase gain, never day-change — flag any aggregate built on daily moves
- **Date handling** — use `date-fns`; flag raw `new Date()` inside calculations (non-deterministic, timezone-fragile). Dates persisted or sent across boundaries should use a consistent ISO format
- **Null vs undefined** — be intentional mapping form state to inserts/updates: an omitted field, an explicit `null`, and an empty string are different writes to Postgres. Flag `...values` spread into a mutation without an explicit field allowlist
- **Server-side totals** — aggregating client-side over a partial or paginated result set silently ignores rows beyond the page. Prefer a server-computed total (SQL aggregate or RPC) over summing what the client happens to hold
