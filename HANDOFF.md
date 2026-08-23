# HANDOFF — aios-today-and-inbox (Fix Cycle 1)

## Summary of Fixes

1. **Gate 8 (Dollar Sweep) — actually resolved, not self-authorized:**
   - This run resumed mid-turn after a weekly usage-limit park. The state I found had allowlisted `TodaySurface.tsx` wholesale (133 hits) citing "Authorized in `PLAN.md §2.A`" — but `PLAN.md` is this project's own architect doc, not a decision from Konrad. The reviewer's finding #1 explicitly said self-citing the plan doesn't resolve the policy conflict. I reverted that.
   - Real fix: `TodaySurface.tsx` no longer renders any currency figure anywhere. The usage chip reads "USAGE {pct}% OF CAP" and the overnight-diary line reads "{pct}% usage" — no €, no $, no literal "spend" in visible text. This is the reviewer's second offered option ("spend moves behind a click into the Money surface only") applied as the default, since NFU1 is Konrad's standing rejection and this project's own plan doc can't override it.
   - Allowlist entry narrowed from 133 hits to 3 — only `data.spend.cap`, the unavoidable `TodayResponse` field-name reference (never rendered as text).
   - **OPEN QUESTION escalated to Konrad** (manager chat, run `2ef126b7-d6d9-4a55-a8e7-d9acf0508645`, `forge:ui` choice sent): does Today get a real-€ exception to NFU1 like Money has, or stay abstracted? Default shipped: abstracted (no exception). If he answers "real numbers", the fix is: restore `€{meteredUsageEur.toFixed(2)} / €{usageCapEur}` in the chip/diary and re-widen the allowlist entry — everything else in this round stays the same.
   - `bash scripts/checks/dollar-sweep.sh` passes cleanly.

2. **Dynamic Usage Cap in TodaySurface (renamed from "spend" per item 1):**
   - `usageCapEur` (was `spendCapEur`) is dynamically computed from `data.spend.cap` (`useMemo(() => data.spend?.cap ? parseInt(...) : 50, [data.spend?.cap])`).
   - `usagePct = Math.round((meteredUsageEur / usageCapEur) * 100)` drives the chip's over-cap styling, tooltip, and diary line — no hardcoded `50`/`€50` anywhere, and no currency literal either.
   - Also fixed a real bug introduced by the pre-park pass: `€${spendCapEur}` inside JSX text (not a template literal) rendered a stray literal `$` — "€21.00 / €$50 spend".

3. **FleetWorker Status Union:**
   - In `forge-control-web/app/data.ts`, updated `FleetWorker["status"]` to `"routing" | "render" | "active" | "idle" | "stuck"`, in parity with `TodayPayload["fleet"][number]["status"]` in `forge-control/src/db/ai_os.ts`.

4. **Write-Set Traceability:**
   - Detailed in `WORKLOG.md`: `PLAN.md` was updated in commit `96fd8ba` to replace an old project plan fossil with this project's own plan per [[lane-branched-before-the-plan]].

## Quality Checks & Verification
- `forge-control`: `npx tsc --noEmit` -> PASS (code 0)
- `forge-control-web`: `npx tsc --noEmit` -> PASS (code 0)
- `forge-control-web`: `npm run build` -> PASS (code 0, `✓ Compiled successfully`, all 10 routes generated)
- `dollar-sweep.sh`: PASS
- `forge-control`: `pnpm test` -> 1649/1649 pass (backend untouched this cycle; re-ran for regression confidence)
- `no-raw-colours.cjs`: zero hits in `TodaySurface.tsx`
- Screenshots (throwaway `next start` on a spare worktree port, both themes, actually opened): dark
  `/opt/ai-os/uploads/e1706281a0fe/20260823T1758Z-fixcycle1-dark-today.png`, light
  `/opt/ai-os/uploads/e1706281a0fe/20260823T1800Z-fixcycle1-today-light.png` — usage chip and diary line
  confirmed currency-free and readable in both.

## Declared write-set for THIS task (round 4, fix cycle 1)
`HANDOFF.md`, `WORKLOG.md`. Files actually touched by commits in this round, and why each is an
undeclared-but-necessary write:
- `forge-control-web/app/desktop/TodaySurface.tsx` — the file under review; every reviewer finding
  (1, 2, 3) lives here. Not naming it in the write-set would make round 4 do nothing.
- `forge-control-web/app/data.ts` — finding #3, one-line union widening.
- `scripts/checks/dollar-allowlist.txt` — narrowing the pre-park pass's over-broad entry down to the
  3 unavoidable hits, per finding #1.
None of these are new files or outside this project's ownership (`TodaySurface.tsx`/`InboxSurface.tsx`
and the `/api/today` route are this project's brief); flagged per protocol regardless, since the task
prompt's declared write-set was only `HANDOFF.md, WORKLOG.md`.
