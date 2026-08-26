# aios-takeover-usable — deploy runbook (the DEP task)

Project `51ddfb27-1dfc-487a-bd3a-e650c963292a`, branch `project/51ddfb27`. Manager chat: run
`2ef126b7-d6d9-4a55-a8e7-d9acf0508645`. Read `PLAN.md` §1.3/§1.4 and `docs/tools/deploy-playbook.md`
§4–§6 first; this file is the takeover-specific overlay, not a replacement.

**Headline: the DEP task restarts `forge-control-web` and nothing else.** Two of the three
processes this project touches are NOT restarted by the deploy task, for two different reasons
stated in §2. Every step below is copy-pasteable; paste each command's output into the evidence
doc (`docs/plan/aios-takeover-usable/deploy-evidence.md`) as you go — an unexecuted check is not
a check.

## 1. What ships where, and which process reads it

| Change | Lives in | Read by | Takes effect when |
|---|---|---|---|
| `TextToVM`, session clock, Done button, reconnect-with-re-mint (`forge-control-web/app/takeover/[runId]/*`) | `forge-control-web` | the Next server (`pm2` id `forge-control-web`, `next start -p 7701`) | **after `next build` + restart — the DEP task does this** |
| socket facts → `takeover-activity.json`, `GET/POST …/takeover/session\|end`, the `upgrade closed` log line (`forge-control/src/lib/browser-takeover.ts`, `takeover-session.ts`, `routes/uploads.ts`) | `forge-control` | the API process (`pm2` id `forge-control`, `tsx src/index.ts`) | **after a forge-control restart — NOT done by the DEP task, see §2.2** |
| durable default profile, `--throwaway`, supervisor clocks (`scripts/research-browser.mjs`) | the checkout | spawned fresh per invocation | the moment the live checkout is at the merge commit — no restart at all |
| `BROWSER_FIRST` prompt sentence (`forge-control/src/lib/project-tick.ts`) | `forge-control` | **the executor** (`forge-executor`), which caches role prompts for its life (playbook §4) | after the detached executor restart, §2.3 |
| `docs/**`, `answer-persistence-anti-detect.md` | the checkout | humans | immediately |

Nothing new is mounted under `/api/browser-takeover/` (`check-browser-takeover-ticket.ts` §6.1
gates it, wired in `gates-808.sh:321`). `DEFAULT_TICKET_TTL_MS` is still `120_000`. No nginx
change: the WS location installed 2026-08-25 (`aios-browser-takeover-live`) is unchanged and
the new routes ride the existing `/api/proxy` path.

## 2. Restarts — who, when, why

### 2.1 `forge-control-web`: yes, and how (the only restart in this task)

`forge-control-web` owns no agent turns; restarting it is always safe. The trap is the BUILD,
not the restart: **never `next build` under the running server in `/opt/forge-ai-os`.** A
Next server resolves chunk hashes from the manifest it read at boot; a rebuild rewrites every
hash on disk, and every fresh page load then dies with `Loading chunk 9927 failed` while
already-open tabs look fine (2026-08-25 02:00, memory note
`next-rebuild-under-running-server-crashes-the-console`). The cron watchdog
`/opt/ai-os/scripts/next-build-drift-watchdog.sh` (`*/3`, 45 s settle, 300 s cooldown) will
eventually restart it, but "eventually" is up to ~4 minutes of a broken console for anyone who
reloads — and it is a safety net for other people's mistakes, not a deploy procedure.

Sequence — stop, build, start; the console is down for the build (≈60–90 s) and never serves
a mismatched manifest:

```bash
# 0. baseline, BEFORE anything: pm2 counters and the live tree must be clean
pm2 jlist | node -e 'for (const p of JSON.parse(require("fs").readFileSync(0,"utf8"))) if (/^forge-/.test(p.name)) console.log(p.name, p.pm2_env.status, "restarts="+p.pm2_env.restart_time, "unstable="+p.pm2_env.unstable_restarts, p.pm2_env.pm_uptime)'
git -C /opt/forge-ai-os status --porcelain          # must be EMPTY; if not, STOP — see live-checkout-dirty-protocol
git -C /opt/forge-ai-os rev-parse main

# 1. merge (playbook §6 steps 1–3): main into the work branch in the worktree, gates, then fast-forward main
cd /opt/ai-os/workspace/projects/51ddfb27-1dfc-487a-bd3a-e650c963292a
git merge main                                       # conflicts → STOP and report the files
(cd forge-control && pnpm install --frozen-lockfile --prod=false && npx tsc --noEmit && pnpm test)
(cd forge-control-web && pnpm install --frozen-lockfile --prod=false && npx tsc --noEmit)
scripts/checks/gates-808.sh                           # the repo suite; check-browser-takeover-ticket.ts is inside it
git -C /opt/forge-ai-os merge --ff-only project/51ddfb27   # or a merge commit if the brief says so

# 2. web: stop → build → start
cd /opt/forge-ai-os/forge-control-web
pnpm install --frozen-lockfile --prod=false          # NODE_ENV=production silently skips devDependencies otherwise
pm2 stop forge-control-web
pnpm build 2>&1 | tail -20                           # expect "✓ Compiled successfully" and /takeover/[runId] in the route table
pm2 start forge-control-web
sleep 3; ss -lntp | grep 7701                         # LISTENING is the proof, not pm2's "online" (memory: pm2-online-but-not-listening)
```

If the build fails, `pm2 start forge-control-web` anyway — the old `.next` is intact until a
successful build replaces it — and report the failure; do not leave the console down.

### 2.2 `forge-control`: NO — Konrad picks the moment

The API side is unguarded and hosts no agent turns (memory note
`forge-control-restart-guard-narrowed-2026-08-25`: `GUARDED = {"forge-executor"}` only), so a
plain `pm2 restart forge-control` would be *permitted*. It is still not done here, because
**a forge-control restart resets every open takeover socket** (`docs/tools/research-browser.md`
§7.4; measured 2026-08-26) and this project exists because a takeover died under Konrad
mid-task. The person who knows whether a takeover is in progress is Konrad. So the DEP task
posts a reminder with the exact command and leaves the restart to him:

```bash
curl -sX POST http://127.0.0.1:7700/api/reminders -H 'content-type: application/json' -d '{
 "text":"aios-takeover-usable is merged; forge-control-web is live. The takeover session clock, Done button and socket log line need ONE forge-control restart, which resets any open takeover socket — run it when no takeover is in progress: setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-control 43200 45 /opt/forge-ai-os/forge-control/ecosystem.config.cjs >> /tmp/safe-restart.log 2>&1 &   (or plain: pm2 restart forge-control)",
 "when":"in 5m"}'
```

(That text is 425 characters, measured with `len()` over the JSON string; the API rejects
> 500 with a 400 — count again before editing it.)
Until that restart the page renders the **session-clock-unavailable message in words**
(the `GET …/takeover/session` route 404s on the old process) — expected, not a blocker, and
exactly what §3.2 verifies. The `safe-restart.sh` form waits for a fleet-idle window that a
busy fleet may never give it (same memory note); `pm2 restart forge-control` completes in ~3 s
and is the one to use if the safe-restart is still "waiting for idle" an hour later. Pass the
ecosystem file if using `safe-restart.sh` — `--update-env` alone does not re-read it.

Not a reason to restart, and not to chase as one: the `ENOENT … scandir
/opt/ai-os/uploads/e2ec11b00001` in forge-control's error log (`uploads-index.ts:131`) is
written 1.4 s after boot and the process stays online for hours after it; a genuine small
defect (a missing run dir 500s the run listing) for its own task, not part of the 120 s story.

### 2.3 `forge-executor`: the detached procedure, launched last, never waited on

`project-tick.ts` is executor-loaded (playbook §4), so the new `BROWSER_FIRST` sentence — the
line that stops runs inventing throwaway profiles — reaches agents only after an executor
restart. **`pm2 restart forge-executor` is forbidden unconditionally**; it hosts every live
turn including the DEP task's own. Launch the detached restart as the very last command of the
task and END THE TASK:

```bash
setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &
```

Never wait for it, poll it or tail its log: the deploy run's own 5 s heartbeat is what keeps
the fleet "not quiet", so the restart provably cannot land while the task is alive (memory note
`safe-restart-blocks-followup-tasks`). If it keeps giving up with "system never went quiet",
the cause is a held/scratch run whose heartbeat is being refreshed, not `MAX_WAIT` — memory
note `held-run-refreshed-heartbeat-blocks-safe-restart` has the SQL to find it.

## 3. What to verify live, and how

All probes hit the public origin `https://os.schreinercontentsystems.com` by name — a request
to `127.0.0.1` proves nothing about what a phone reaches. Screenshots go to
`/opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-<label>.png` and are `Read` back so the manager chat
renders them.

### 3.1 The page renders, authenticated, with the input visible on a phone viewport

Mint a session cookie the way the LIVE server expects it (memory notes
`real-client-network-capture-recipe`, `live-https-cookie-salt-is-the-secure-prefixed-name`,
`nextauth-salt-must-equal-cookie-name`):

- `AUTH_SECRET` comes read-only from `/opt/forge-ai-os/forge-control-web/.env.local` — source
  it into the probe's environment, never copy it anywhere, never print it.
- The live `AUTH_URL` is https, so `useSecureCookies` is true and the salt **is** the prefixed
  cookie name: encode with `salt: "__Secure-authjs.session-token"` and send the cookie under
  that same name. The bare `authjs.session-token` salt from the phase-1871 http recipe 307s to
  `/signin` on the live host and looks exactly like a broken deploy.
- Import `@auth/core/jwt` by its resolved path under
  `forge-control-web/node_modules/.pnpm/@auth+core@<ver>/node_modules/@auth/core/jwt.js`; the
  bare specifier does not resolve outside the package that declares it.
- **Negative control first**: the same request with a cookie minted from a wrong secret must
  307 to `/signin`. Without it a stale or wrong mint reads as "the deploy broke".

Then, with a run id that has a live profile (`scripts/research-browser.mjs status` prints
the takeover URL; a `--throwaway` profile is fine for this and is closed at the end):

```bash
curl -s -o /dev/null -w '%{http_code}\n' --cookie "__Secure-authjs.session-token=$TOKEN" \
  https://os.schreinercontentsystems.com/takeover/<runId>            # 200
```

Drive it with Playwright (`executablePath: "/usr/bin/google-chrome"` — the bundled revision
pin is stale on this box, memory note `playwright-driver-two-launch-traps`), viewport
390×844, cookie set on the domain, and assert: the multi-line textarea and its Send button are
inside the viewport without scrolling; the segmented switch defaults to *Type keys*; the
Done button is ≥ 44 px tall. Screenshot → `<stamp>-takeover-phone.png`, `Read` it back.

### 3.2 The clock message before the forge-control restart — expected, not a blocker

While forge-control is still the old process, `page.on("response")` filtered on the **exact**
pathname `/api/proxy/uploads/<runId>/takeover/session` must show `404`, and the header must
render the unavailable message in words (the exact string is in
`forge-control-web/app/takeover/[runId]/` — grep for the 404 branch and quote it). Paste both.
A blank header or a spinner here is a real defect. After Konrad's restart the same request
returns `200` with `remaining_ms`, and the header shows `ends in h:mm:ss` — that half is
verified by whoever runs the restart, or by a detached watcher that captures forge-control's
`restart_time` and polls (memory note `safe-restart-blocks-followup-tasks` has the shape).

### 3.3 The socket survives a text send, and nothing logs the text

Type a sentinel that cannot occur naturally (e.g. `zq7-sentinel-<stamp>`) into the input,
send it with *Type keys*, then:

```bash
grep -c 'zq7-sentinel' /root/.pm2/logs/forge-control-out.log /root/.pm2/logs/forge-control-error.log \
  /root/.pm2/logs/forge-control-web-out.log /root/.pm2/logs/forge-control-web-error.log \
  /opt/ai-os/browser-profiles/.state/<profile>/*.log                    # every count must be 0
```

Zero hits across every log is the assertion — paste the command and its output. Read the
text back from the VM the way R1 did (`docs/plan/aios-takeover-usable/research-keysym.md`
§6: a textarea on a page the VM has open, `page.evaluate` of its value through the module
trick) to prove the bytes arrived; the sentinel must include one umlaut and one `\n`.

### 3.4 Cleanup

`scripts/research-browser.mjs close <throwaway-profile>` for anything raised during
verification; confirm with `pgrep -af "Xvfb :<n>"` empty. Nothing under
`/opt/ai-os/browser-profiles/` is deleted — the throwaway directory stays, marked.

## 4. Final message of the DEP task

What changed (files), the gate output from §2.1 step 1, the pm2 triple before/after for
`forge-control-web` (restart counter +1, `unstable` unchanged, listening on 7701), the reminder
id from §2.2, the statement that `pm2 restart forge-executor` was NOT run and that the detached
restart was launched, the §3 evidence with screenshot URLs, and the one thing Konrad owes the
system: the forge-control restart at a moment of his choosing, and his profile-migration answer
(`docs/tools/research-browser.md` §4.1 — default C, fresh `konrad-main`, stands if silent).

## 5. Write-set ledger — commits that touched files outside their task's declared write_set

Recorded here per the round-10 review (finding 4) so the deploy reviewer does not have to
rediscover them from `git log`. Every entry was disclosed in its own commit message; none was
declared on a task row.

| commit | task (write_set as declared) | undeclared paths | why it had to change |
|---|---|---|---|
| `b98f2d3` | R8 ui `29d35773` — the three `forge-control-web/app/takeover/[runId]/` files | `scripts/checks/check-takeover-text-input-e2e.ts`, `scripts/checks/check-vm-keys.ts` | the checks that pin the new wording ("sent", never "typed") and the header clock; they could not stay green without the edit. The lane died uncommitted; the round-9 integrator recovered and committed it. |
| `ef6dab3` | R9 integrator `1bd633ea` — write_set `{}` (empty) | `forge-control-web/app/takeover/[runId]/TextToVM.tsx`, `forge-control-web/app/takeover/[runId]/vm-keys.ts` | gate 9 (`dollar-sweep`) greps the euro glyph; two comments and one feedback string were rewritten to "the euro sign" / U+20AC. |
| fix cycle 2 (round 11) | builder task — write_set `{}` (empty; the reviewer's verdict names the intended set) | `scripts/research-browser.mjs`, `forge-control/src/lib/research-browser-cli.test.ts`, `scripts/checks/gates-808.sh`, `scripts/checks/check-takeover-text-input-e2e.ts`, `docs/plan/aios-takeover-usable/evidence-text-input.md`, this file | round-10 verdict items 1–4: the cap-origin fix + its regression test, the two `skip` rows, the §B8 evidence, this ledger. `check-vm-keys.ts` was named in the verdict's intended set and was NOT touched. |
