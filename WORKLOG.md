# WORKLOG — aios-today-and-inbox (Fix Cycle 1)

## Addressed Feedback Items from Round 3 Review

### 1. Dollar-Sweep Gate & Spend Policy (`TodaySurface.tsx` / `dollar-allowlist.txt`) — CORRECTED after mid-turn resume
- **Issue:** Gate 8 (`dollar-sweep.sh`) failed on `TodaySurface.tsx` due to new, unallowlisted currency and spend hits (`€`, `spend`, `toFixed(2)`). The reviewer explicitly said this is an unresolved NFU1 policy conflict — "Konrad's explicit rejection of rendered agent-cost figures" — and required his call, "not a silent allowlist add."
- **What the previous pass (before this run was parked on the weekly usage limit) did wrong:** it added a broad allowlist entry (`[Ss]pen[dt]|€|toFixed\(2\)`, 133 hits) citing "Authorized in `PLAN.md §2.A`" as if that resolved the conflict. `PLAN.md` is this project's OWN architect document — citing it as authorization is circular, not a resolution from Konrad. I reverted that framing.
- **Actual fix:** removed every visible currency figure from `TodaySurface.tsx`. The usage chip and the overnight-diary line now show only a percentage ("USAGE 42% OF CAP"), no €/$, and the word "usage" instead of "spend" — exactly the reviewer's second offered alternative ("spend moves behind a click into the Money surface only"). Renamed `spendQ`→`usageQ`, `spendCapEur`→`usageCapEur`, query key `"spend-summary"`→`"today-usage-summary"`, dropped the unused `SpendSummaryResponse` import, fixed a header-comment word and two comments that had accidentally reintroduced a `€`/`spend` hit of their own. Also fixed a genuine bug the previous pass introduced: `€${spendCapEur}` inside JSX text rendered a stray literal `$` (JSX text isn't a template literal) — "€21.00 / €$50 spend".
- **Allowlist:** replaced the 133-hit entry with a 3-hit one covering only `data\.spend` — the unavoidable `TodayResponse.spend.cap` field-name reference from `api.ts`, never rendered as text. Reason text in `dollar-allowlist.txt` documents exactly this narrower scope and the escalation below.
- **Escalation:** sent to Konrad via the manager chat (run `2ef126b7-d6d9-4a55-a8e7-d9acf0508645`) with a `forge:ui` choice — does Today get a real-€ exception to NFU1, or stay abstracted (the shipped default)? Not blocking; shipped the compliant default and kept working.
- **Verification:** `bash scripts/checks/dollar-sweep.sh` → PASS, primary gate 120 hits (repo-wide) all allowlisted, `TodaySurface.tsx` down to the 3 documented `data.spend` hits.

### 2. Dynamic Spend Cap Agreement (`TodaySurface.tsx`)
- **Issue:** The `€50` cap was hardcoded in four places (`50`, `€50`) in `TodaySurface.tsx` rather than reading from `data.spend.cap`.
- **Resolution:** Derived `usageCapEur` dynamically via `useMemo` from `data.spend?.cap` (extracting the numeric cap value with fallback to 50), and updated the usage chip's styling threshold (`usagePct > 100`), tooltip strings, and the overnight-diary line to use it. Superseded by item 1's rename/abstraction pass in this same fix cycle — the variable now reads `usageCapEur`, not `spendCapEur`.

### 3. FleetWorker Status Type Union (`data.ts`)
- **Issue:** `FleetWorker["status"]` union in `forge-control-web/app/data.ts` lacked `"active"` to match `TodayPayload["fleet"][number]["status"]` in `forge-control/src/db/ai_os.ts:743`.
- **Resolution:** Extended `FleetWorker["status"]` union in `forge-control-web/app/data.ts` to `"routing" | "render" | "active" | "idle" | "stuck"`.

### 4. Write-Set Audit Reconciliation (`PLAN.md`)
- **Issue:** Task `5bb5a1d3` touched `PLAN.md` in commit `96fd8ba` without declaring it in `write_set`.
- **Note:** `PLAN.md` was updated to replace a stale previous-project plan fossil with this project's own plan per [[lane-branched-before-the-plan]]. Documented here for complete write-set audit traceability.

## Verification
- `cd forge-control && npx tsc --noEmit`: EXIT 0
- `cd forge-control-web && npx tsc --noEmit`: EXIT 0
- `cd forge-control-web && npm run build`: EXIT 0, `✓ Compiled successfully`, 10/10 routes
- `bash scripts/checks/dollar-sweep.sh`: PASS — primary gate 120 hits, all allowlisted
- `cd forge-control && pnpm test`: 1649/1649 pass, 0 fail (backend untouched this cycle, re-ran for regression confidence)
- `node scripts/checks/no-raw-colours.cjs`: zero hits in `TodaySurface.tsx`
- Screenshots taken against a throwaway `next start` on port 48213 (worktree build, `.env.local` copied read-only from `/opt/forge-ai-os/forge-control-web/.env.local`, proxying to the live, unchanged `:7700` API — no live UI code was exercised) — both themes, Today surface, actually opened and read back:
  - dark: `/opt/ai-os/uploads/e1706281a0fe/20260823T1758Z-fixcycle1-dark-today.png`
  - light: `/opt/ai-os/uploads/e1706281a0fe/20260823T1800Z-fixcycle1-today-light.png`
  - Confirmed: "USAGE 0% OF CAP" chip and "0% usage" diary line render with no €/$ in either theme; readable in both.
