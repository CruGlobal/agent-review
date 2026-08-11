# UX — Focus Areas

Project-specific UX/UI conventions layered on top of the UX agent's universal checks.

- **Material UI v9 conventions** — use the `sx` prop for styling; avoid `makeStyles` (legacy) and avoid inline `style={...}` (breaks theme-aware styling and responsive breakpoints). Styled components (`styled(...)`) are acceptable for reused patterns
- **Theme tokens, not hardcoded values** — use `theme.palette.*`, `theme.spacing(n)`, `theme.breakpoints.*`. Flag raw hex colors, pixel values, and magic numbers
- **Responsive design** — MUI breakpoints (`xs`, `sm`, `md`, `lg`, `xl`) via `sx={{ display: { xs: 'block', md: 'flex' } }}`. New components must render correctly at mobile widths
- **Loading states** — every React Query (`useQuery`) read must render a loading state (MUI `Skeleton` or `CircularProgress`), not render nothing or flash stale content
- **Error states** — every React Query read must render an error state (`<Alert severity="error">` or similar). Never let an error silently render empty content
- **react-hook-form field wiring** — wire fields with `register` or `Controller` so `name`, `value`, `onChange`, and `onBlur` connect to form state; surface `formState.errors` at the field
- **Form error visibility** — validation errors (zod via `zodResolver`) must be visible next to the field (MUI `TextField` with the `error` prop + `helperText`), not only in a toast or summary
- **Accessibility (a11y)**
  - All interactive elements need accessible names (`aria-label`, `aria-labelledby`, or visible text)
  - Icon-only buttons must have `aria-label` (MUI `IconButton` doesn't add one automatically)
  - Form fields must have associated labels (MUI `TextField` with `label` prop, or explicit `<InputLabel>` + `htmlFor`)
  - Dialogs use `<Dialog>` with `aria-labelledby` pointing at the title
  - Color should never be the only indicator of state (add icons or text) — applies to gain/loss surfaces, which lead with since-purchase gain
  - Keyboard navigation works (tab order, Enter/Space activation, Escape closes modals)
- **Notification usage** — success/error feedback goes through the app's existing notification mechanism, not ad-hoc `alert()` or inline text
- **Dialog UX** — dialogs have clear primary/secondary actions, disable the primary action while submitting, and close on success
