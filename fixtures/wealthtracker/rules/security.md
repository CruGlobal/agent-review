# Security — Focus Areas

Project-specific concerns added to the Security agent's universal checks.

- **Service-role client containment** (`src/lib/supabase/admin.ts`) — the SERVICE_ROLE client and `SUPABASE_SERVICE_ROLE_KEY` must NEVER be imported into a client component, a `"use client"` module, or anything reachable from the browser bundle. Flag any `NEXT_PUBLIC_` exposure of the service-role key
- **Supabase client selection** — browser code uses `client.ts`; route handlers (`src/app/api/**/route.ts`) and server actions use `server.ts` (cookie-bound session). Flag a browser client used where a session must be verified, or `admin.ts` used in place of the session-bound `server.ts`
- **RLS is the authorization boundary** — every route handler and server action must rely on RLS *and* independently verify the session and household ownership; never trust `userId`/`householdId` from client input. RLS policy changes in `supabase/migrations/*.sql` that loosen row scoping are a red flag
- **Environment variable exposure** — server-only variables must NOT be prefixed with `NEXT_PUBLIC_` (that ships them to the client bundle); audit every new `process.env.*` reference
- **Secrets never logged or returned** — Plaid, Stripe, Anthropic, and Resend keys/tokens must never appear in logs, error messages, or API responses
- **Stripe webhook verification** (`src/lib/stripe`, `src/lib/billing`) — webhook route handlers must verify the signature via `stripe.webhooks.constructEvent` using the raw body; flag handlers that parse JSON before verifying
- **Plaid token handling** (`src/lib/plaid`) — `access_token` is server-only and must never be returned to the client or stored where the browser can read it; only `link_token`/`public_token` cross the boundary
- **Open redirect on auth flows** — auth-callback, set-password, and recovery-link handlers must validate any redirect target (query param, `redirectTo`) against an allowlist before `redirect()`/`router.push()`/`window.location`
- **Server-side validation parity** — every client-side `zod` schema, `disabled` button, and `required` field must have a server-side `zod` parse in the route handler/server action. If a mutation silently trusts the client, flag it
- **CSP and security headers** in `next.config.ts` — any weakening (new `unsafe-inline`, `unsafe-eval`, added origins, removed headers) is a red flag
- **XSS surfaces** — `dangerouslySetInnerHTML`, `innerHTML`, direct DOM writes; flag any use in new code and verify input is sanitized
- **CI/CD workflow security** — any change to `.github/workflows/**` must verify permission scopes are minimal, secrets are not exposed in logs, and trigger conditions cannot be abused to bypass review
- **Review process integrity** — changes to `.claude/commands/**`, `.claude/rules/**`, or `.claude/settings.json` must verify risk scoring is not weakened, severity thresholds are not lowered, critical checks are not stripped, and newly enabled plugins/marketplaces come from trusted org-controlled sources
