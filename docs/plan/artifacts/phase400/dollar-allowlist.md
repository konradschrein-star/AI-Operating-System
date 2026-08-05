# Phase 400 / Round 401b — dollar-allowlist

U11 ("no dollars anywhere") + NFU1. Scope: **forge-control-web only, outside the chat surface** — the files this round's other 401 task owns (`ChatSurface.tsx`, `ManagersSection.tsx`, `agentsApi.ts`, `app/api.ts`, `globals.css`) are read here for the sweep but not edited; the chat header's own dollar line is explicitly round 402's job.

This table is the prose form of `scripts/checks/dollar-allowlist.txt`, which `scripts/checks/dollar-sweep.sh` reads to decide, mechanically, whether a hit is excused. Regenerate this table by re-running the sweep script and copying its `ALLOW` block if the underlying code moves — line numbers below are a snapshot, not a promise.

## Edits made this round (no longer hits)

| File | What changed |
|---|---|
| `app/desktop/live/AgentActivity.tsx:376` | Deleted `{a.spent_usd > 0 && <span>${a.spent_usd.toFixed(2)}</span>}`. Nothing replaces it — the row's first line already renders `↑/↓` token counts via `humanTokens`. |
| `app/desktop/live/AgentActivity.tsx` (panel header) | `${s.spent_usd_last_hour.toFixed(2)}/h` replaced with `↑ {humanTokens(s.tokens_out_last_hour)} ↓ {humanTokens(s.tokens_in_last_hour)} /h`, sourced from the same `summary` object (`agentsApi.ts` — read, not edited), rendered only when at least one of the two is `> 0`. |
| `app/desktop/live/AgentActivity.tsx` (doc comments, top-of-file + `downloadedTokens` + second-line comment) | Rewrote the ASCII row diagrams and prose to drop `$4.10`/`$1.02` and the word "spend" — they now describe what the row actually renders (role/model/effort/activity, no currency). |
| `app/desktop/DesktopApp.tsx:113` | `"live token / spend panel"` → `"live token panel"` (CHAT placeholder-surface copy). |
| `app/desktop/DesktopApp.tsx:124` | `"cards show progress + cost + ETA"` → `"cards show progress + ETA"` (PIPELINE placeholder-surface copy). |
| `app/MobileApp.tsx` | Removed the `SPEND TODAY` `StatCard` from the Today screen's tile row; `SHIPPED` now sits alone in a `flex: 0 1 50%` wrapper so it reads as one intentional card, not a stretched leftover. `data.spend` (from `TodayResponse`) has no remaining renderer anywhere in the app (verified by grep). |

Confirmed clean (swept, zero hits, no edit needed): `PipelineSurface.tsx`, `DesktopApp.tsx`'s `StatusBar`/`QuotaBars`.

## Surviving hits — every one, and why it may live

| File | Line(s) | Snippet | Why it lives |
|---|---|---|---|
| `app/Providers.tsx` | 10 | `// … chat list, file tree, memory, skills, projects, spend —` | Comment enumerating react-query cache domains. "spend" here names the *Money surface's query key*, not a rendered value. |
| `app/api.ts` | 169, 176–207, 211, 225, 602–603, 698, 1092 | `Spend*` interfaces, `fetchSpendSummary`, `getJson<SpendSummaryResponse>("/spend/summary")`, `RunSummary.budget_usd`/`spent_usd`, `TodayResponse.spend` incl. `emptyToday`'s `"€0.00"` literal | The `Spend*` types + `fetchSpendSummary` feed **MoneySurface.tsx**, the dedicated MONEY destination (see below) — real, intentional rendering there. `RunSummary.budget_usd`/`spent_usd` are wire-compat (NFU4 additive API); `ChatSurface.tsx` is the only place that reads them today and that read is a documented open item (see the `ChatSurface.tsx` row below), round 402's job. `TodayResponse.spend` (and its `emptyToday` default) is now fully orphaned — `MobileApp.tsx`'s `SPEND TODAY` card was its last renderer and this round removed it; the field stays on the wire shape per NFU4 rather than being reshaped mid-phase. `app/api.ts` is owned by the parallel 401 task this round, not this task — noted here, not edited here. |
| `app/desktop/live/agentsApi.ts` | 13, 28, 86, 119 | `cost_usd?: number;` / `spend row` (comment) / `spent_usd: number;` / `spent_usd_last_hour: number;` | Wire types kept per NFU4 (additive API). After this round's `AgentActivity.tsx` edits, **nothing renders any of them** — verified by grep across `app/desktop/live/`. `agentsApi.ts` is owned by the parallel 401 task; noted here, not edited here. |
| `app/desktop/MoneySurface.tsx` | whole file (4, 8, 19, 23, 28, 52, 57, 63, 75, 78, 87, 92, 139, 314, 318, 334, 414) | `` `€${v.toLocaleString(…)}` ``, `Money · AI Spend`, `DAILY SPEND · 30 DAYS`, etc. | **The dedicated MONEY destination.** It renders € on purpose: real metered provider spend (images, TTS, video, gateway calls) **outside** the flat-rate Claude Code subscription — it already labels claude-code's own line as "notional." This is a business number, not the agent-cost noise Konrad rejected in `10-ui-v3-spec.md`. Phase 400 deliberately leaves it alone. **OPEN QUESTION for Konrad, not decided here: should the MONEY destination be killed too, or does it stay because it tracks real non-subscription spend?** |
| `app/desktop/MemorySurface.tsx` | 598 | `{h.score.toFixed(2)}` | `h.score` is a search-result **relevance score** (0–1-ish float), not currency. False positive of the naive `toFixed(2)` pattern. |
| `app/desktop/live/AgentActivity.tsx` | 97 | `` return `${M < 10 ? M.toFixed(2) : M.toFixed(1)}M`; `` | Inside `humanTokens()` — formats a token count's `M`-suffix (e.g. `"1.23M"` tokens). Magnitude, not currency; false positive of the naive `toFixed(2)` pattern. |
| `app/desktop/chat/slash-registry.ts` | 68, 242, 259, 263 | `/** … guardrail rules (spend caps, kill switches) …`, `/cap spend.per_run_cap 75`, etc. | `/rules` and `/cap` configure **real autonomy spend-cap guardrails** — a control Konrad sets, not a display of a dollar amount charged. Kept. Owned by the parallel 401 task; noted here, not edited here. |
| `app/desktop/ChatSurface.tsx` | 1407–1408 | `` {run.status} · {engine} · {model} · spent ${run.spent_usd} / cap ${run.budget_usd} · `` | **Not yet removed — a documented open item, not a resolved allowlist entry.** This is the chat header's dollar/cap line. Per this task's file-ownership split, `ChatSurface.tsx` is owned by a parallel task this round, and the brief states explicitly: *"the chat header's dollars are round 402's job."* `dollar-sweep.sh` excuses it so this round's gate can pass without touching a file outside its scope, but round 402 must delete this line for U11 to be fully satisfied app-wide. |

## Every `isPending` match under the naive §6 command

`grep -rniE "usd|spend" forge-control-web/app --include="*.tsx" -l` (the reviewer's literal command from `14-ui-v3-quality.md` §6) returns, beyond the genuine hits above:

- `app/MobileApp.tsx`
- `app/desktop/SkillsSurface.tsx`
- `app/desktop/ProjectsSurface.tsx`
- `app/desktop/DesktopApp.tsx`
- `app/desktop/AutomationSurface.tsx`

Every one of these matches purely because `"spend"` case-insensitively matches the middle of `isPending` (`i-s-P-e-n-d-i-n-g`) — a `useMutation().isPending` loading-state flag, present in ~15 places app-wide as of this round. None renders a dollar figure. This is exactly why `dollar-sweep.sh`'s primary gate uses `\bspen[dt]` (word-boundary anchored) instead: the anchor requires a word boundary immediately before `spen`, and `isPending`'s `s` is preceded by the word character `i`, so no boundary exists there and the anchored pattern never fires on it. `dollar-sweep.sh` runs the naive §6 command too and classifies every file it returns — see its "REVIEWER'S LITERAL §6 COMMAND" section — so a reviewer running §6 by hand gets this same triage instead of re-deriving it.

## Verification

```
cd forge-control-web && npx tsc --noEmit                      # clean (0 errors this round; ChatSurface.tsx errors, if any, belong to the parallel 401 task)
bash scripts/checks/dollar-sweep.sh                            # exit 0
grep -rnE '\$[0-9]|€' app/desktop/live/AgentActivity.tsx app/desktop/DesktopApp.tsx app/MobileApp.tsx   # zero hits
```

---

# Phase 400 / Round 402 — dollar sweep, part 2 (the chat surface)

Round 401b closed everything **outside** the chat surface and left exactly one
open item: the chat header's `spent $X / cap $Y` line, deferred because
`ChatSurface.tsx` belonged to a parallel task that round. Round 402 owns that
file and closed it. **U11 is now complete app-wide** — no surface renders an
agent-cost dollar except the deliberate MONEY destination.

## Edits made this round

| File | What changed |
|---|---|
| `app/desktop/ChatSurface.tsx` (header, was ~1380–1413) | Header rebuilt for U12. Deleted: `run.title`, the `{run.status}` word, `{engine}`, and `spent ${run.spent_usd} / cap ${run.budget_usd}` — **the last rendered dollar in the chat surface**. The `const engine = …` line went with it (its only reader). What remains: status dot with `live`/`polling` docked underneath as one unit, the model name, the NFU6 linkage markers, then the unchanged `headerExtra` / resume / cancel actions. |
| `scripts/checks/dollar-allowlist.txt` | Removed the `ChatSurface.tsx` row (replaced by a comment recording why it is gone). It was never a real waiver — 401b wrote it as a **documented open item** so that round's gate could pass without editing a file it did not own. The line it excused no longer exists, so the row would now be allowlist rot: it would silently pre-excuse a *future* `spent_usd`/`budget_usd` regression in that file. With the row gone, any dollar returning to `ChatSurface.tsx` fails the gate. |

## Surviving hits — the delta from 401b

**No new entries.** The allowlist shrank by one; nothing was added. The
surviving set is exactly 401b's table minus the `ChatSurface.tsx` row:
`Providers.tsx` (comment), `api.ts` (wire types, NFU4), `agentsApi.ts` (wire
types, NFU4), `MoneySurface.tsx` (the deliberate MONEY destination — the open
question for Konrad about killing it stands, undecided here),
`MemorySurface.tsx` (relevance score `toFixed(2)`), `AgentActivity.tsx`
(token-magnitude `toFixed(2)`), `slash-registry.ts` (spend-cap *controls*).

One nuance worth recording for the next reader: the new header carries a
comment explaining what U11 removed, and the natural phrasing ("spend/cap")
would itself have tripped the word-boundary-anchored primary gate from inside a
comment. Reworded to "the cost/cap line" rather than allowlisted — a gate you
teach yourself to route around stops being a gate.

`ChatSurface.tsx` now appears under the reviewer's literal §6 command only as an
`isPending` false positive, and the sweep classifies it as such automatically.

## Verification (round 402)

```
forge-control-web $ npx tsc --noEmit                 # clean
forge-control     $ npx tsc --noEmit                 # clean
forge-control-web $ NODE_ENV=production pnpm build   # ✓ 9/9 static pages, no errors
$ bash scripts/checks/dollar-sweep.sh                # PASS — 46 hits, all allowlisted (was 47)
$ grep -nE '\$[0-9]|€|spent_usd|budget_usd' forge-control-web/app/desktop/ChatSurface.tsx   # zero hits
$ git diff forge-control-web/app/desktop/ChatSurface.tsx | grep '^+' | grep -E '#[0-9a-fA-F]{3,8}|rgb\(|hsl\('  # zero (NFU1)
```

Both themes: the header's five tokens (`borderSoft`, `ok`, `warn`, `textFaint`,
`textMuted`) each resolve in both palettes — verified as two definitions apiece
in `app/theme.css` (`:root` dark + `html[data-theme="light"]`). Screenshots are
round 403's job.
