# phase5/business-spine-ruling.md — which spine the Businesses tab got, and on whose authority

Phase 5, workstream `business`, task 3 of 4. Requirements R59–R63.

Companion to `browser-harness.md` (how the measurements below were taken) and
`premises-remeasured.md` (round 0's three premises that did not survive).

---

## 1. The ruling

**Spine: FUNNEL.** Stage counts per arm, and the one next action.

**Whose ruling: THE DEFAULT, not Konrad's answer.** He has not replied. Round 0
put the choice to him in the manager chat and stated FUNNEL as the default if
unanswered; the default is what was taken, and this document exists so that
nobody later mistakes a default for a decision.

| | |
|---|---|
| Decided | 2026-08-18 (this task) |
| Mechanism | default-on-silence, declared in advance by round 0 |
| Question asked | 2026-08-18T18:51:39.618Z |
| Konrad's last message in the run | 2026-08-18T19:56:11.939Z — **after** the question, and **not an answer to it** |
| Reversible? | Yes, cheaply. The stage list is data (`DIRECTORY_FUNNEL`), not layout. |

### 1.1 The evidence, and a correction to the task brief

The brief instructed: *"Konrad's last human message in that run is
2026-08-18T18:43:16Z, BEFORE it; there is no reply after it."* **That is wrong
in its detail and right in its conclusion**, and the difference is worth
recording because the brief's version would have been falsified by a glance at
the thread.

Read-only, against forge-control's `DATABASE_URL`:

```sql
SELECT n, e->>'role', coalesce(e->>'at','(no-ts)'),
       left(regexp_replace(coalesce(e->>'text',e->>'content',''),'\s+',' ','g'),110)
FROM runs r, jsonb_array_elements(r.thread::jsonb) WITH ORDINALITY AS t(e,n)
WHERE r.id='bfd1283a-b71b-4f35-b577-7d09aad803f2' AND n>=2291 ORDER BY n;
```

```
2291 | user      | 2026-08-18T18:51:39.618Z | [message from worker 2ba5db07] Businesses tab — which spine? (default if you do not answer: FUNNEL, because it…
…
2334 | user      | 2026-08-18T19:02:48.979Z | [message from worker 1fc5b5d1] Round 960 (GRAPH_GUIDE workstream criterion) — done in the worktree…
2335 | system    | 2026-08-18T19:02:50.043Z | Run blocked: Per-run spend cap — per-run spend EUR 75.20004 exceeds cap EUR 75
2336 | user      | 2026-08-18T19:13:31.472Z | [message from worker 7b6cccc8] S-C done (round 499)…
2338 | user      | 2026-08-18T19:14:13.963Z | [message from worker db36f586] S-A (agy login, round 399) done…
2340 | user      | 2026-08-18T19:56:11.939Z | Drop the spend cap please.
2341 | system    | 2026-08-18T19:56:13.805Z | Run blocked: Per-run spend cap — per-run spend EUR 75.29088 exceeds cap EUR 75
```

Three facts follow, and only the third is the one the brief claimed:

1. **`role='user'` is not the same as "Konrad".** Worker reports are posted into
   the thread with `role='user'` and a `[message from worker <id>]` prefix. Any
   filter that trusts the role alone reads eight worker reports as eight human
   messages. Entries 2334/2336/2338 are workers, not him.
2. **There IS a human message after the question** — entry 2340, at 19:56:11Z,
   65 minutes after it. The brief said there was none. It reads, in full,
   *"Drop the spend cap please."*
3. **It is not an answer to the spine question**, and no other human message
   follows it. So the default stands, exactly as the brief concluded.

The correction matters because #2 is the kind of fact a reviewer checks. Had it
been an answer, this task would have built the wrong thing on the strength of a
premise nobody re-measured.

### 1.2 Why he did not answer, which is not the same as not caring

The run was blocked on a per-run spend cap from **19:02:50Z** onward, and it is
still blocked — every subsequent message, his included, was answered by
`Run blocked: Per-run spend cap`. His one human contribution in that window was
an attempt to *unblock the run*, which the run then failed to act on because it
was blocked. The run's status is `failed`.

**This is a finding for the manager, not a detail of this task:** Konrad asked
for the cap to be lifted at 19:56Z and nothing happened. If the spine choice
matters to him, he never got the chance to make it — he was talking to a dead
run. Flipping the spine later costs one small edit; that is why this was safe to
default, and it is also why the default should not be read as consent.

---

## 2. The spec, quoted with line references (R60)

Source: `/opt/obsidian-vault/AI OS/Specs/Directory + Business Plan Hub — Business Model.md`
(1,164 lines, last modified 2026-08-04). Every figure rendered on the Directory
card is a quotation from it, and the surface says so on screen.

### 2.1 The canonical stages — §3.2, lines 259–266, amended by the second §10

| # | Stage | Line | Entry criterion (condensed) |
|---|---|---|---|
| 1 | Sourced | L259 | `places` row matching the ICP filter — `territory='jersey'`, target profession, `on_niche=1`, phone or verified email, completeness above the floor. *"Machine-assigned, never manual."* |
| 2 | Compliance-cleared | L260 | Corporate subscriber confirmed, or TPS/CTPS screened within 28 days. *"A row may not skip this stage. If the check has not run, it must hard-error, not default to allowed."* |
| 3 | Contacted | L261 | First touch sent or dialled, logged with channel and timestamp. |
| 4 | Engaged | L262 | Replied, answered, or clicked the claim/booking link. |
| 5 | Qualified | L263 | Discovery call completed **and** three facts recorded: named need, who does that work today, who signs off on spend. |
| 6 | Proposed | L264 | A written, priced scope of work has been sent. |
| 7 | **Committed** | **L784, L788–791** | **Not in §3.2.** Added by the later §10 — see §3 below. |
| 8 | Won — Client | L265 | *"The first payment has cleared. Not signature. Not verbal agreement. Cash."* |
| — | Lost / Disqualified | L266 | Reachable from any stage. *"Requires a reason code — no free text"*: `no_response`, `not_qualified`, `no_budget`, `has_provider`, `compliance_block`, `bad_data` — plus `signed_never_paid` (L800). |

A funnel drawn from §3.2 alone would have seven stages and would be one Konrad
has already superseded. Eight is correct.

### 2.2 The other rulings that bind, and are honoured

| Ruling | Line | Where it shows |
|---|---|---|
| Layer 1 only — directory listings | §10 Q1 L700 | Directory tagline |
| £49/month | §10 Q2 L701 | tagline; *Proposed* provenance |
| Ian owns outreach (Konrad may take the first ~20) | §10 Q3 L702 | the NEXT ACTION block |
| Accountants, Jersey | §10 Q5 L704 | tagline |
| Twenty CRM, no Close.com, no paid dialer | §10 Q10 L705 | tagline |

---

## 3. The precision the project brief gets wrong — signature vs cash

The brief asked for this to be **resolved in writing rather than by copying
either phrasing**. Here is the resolution.

### 3.1 The document contradicts itself because it has TWO sections numbered 10

`grep -n '^## ' ` on the spec returns `## 10.` at **line 694** ("Decisions —
2026-08-04, second pass") and again at **line 764** ("Signature, payment, and
the boundary between them — 2026-08-04"). That duplication is the whole trap:
a reader who opens "§10" gets whichever one they land on.

- **§10 Q4, line 703** — *"What counts as won?"* → **"Signature."** It then
  points the reader at *"§11 on where payment belongs"*.
- **That pointer is stale.** §11 (line 887) is *"Do we need an ERP?"*. The
  section that actually answers it is the *second* §10, at line 764.

### 3.2 What supersedes what

The later §10 supersedes the **mechanism**, and §3.4's decision is explicitly
reaffirmed rather than overturned — line 788: *"§3.4 already decided won = first
payment cleared. That decision stands."*

Line 776–778, the rule stated once so it never has to be re-argued:

> **Signature is a CRM event. Cash is a ledger event. Neither one implies the
> other, and neither one may be written on behalf of the other.**

Three moments, three different writes (L784–786):

| Moment | CRM (Twenty) | Ledger (`ledger_entries`) |
|---|---|---|
| A priced scope is **signed** | Stage → **Committed**, with `signed_on` and a **mandatory** `expected_first_payment_on` | **Nothing. Not one row.** |
| The **first payment clears** | Stage → **Won — Client**. Fires **once, ever** | Row #1: `direction='in'`, `source='stripe'`, `external_ref` = the charge id |
| Payments 2…n | **Nothing** — a subscription does not re-close | One row per successful charge, forever |

And the case that decides whether the stage set is honest (§10.2, L797–800): a
record may not sit in Committed indefinitely. **14 days past
`expected_first_payment_on` with no cleared payment → Lost, reason code
`signed_never_paid`.**

### 3.3 The resolution, in one line

**Q4 is not wrong about what Konrad DOES at signature; it is incomplete about
what signature MEANS. Signature closes the conversation. Cash closes the deal.**

That sentence, the table above and the 14-day rule are rendered on the Directory
card behind the always-visible headline *"Signature is a CRM event. Cash is a
ledger event."* — see `DIRECTORY_WON_RULE` in `businesses-inventory.ts`.

---

## 4. THE NEGATIVE RESULT — Directory is not live-probeable from VPS1

Recorded so nobody burns an hour re-deriving it. **The brief's conclusion is
right; its stated reason is not, and the real reason is more useful.**

The brief said: *"VPS2 is unreachable (no `/root/.ssh/vps2_mgmt` key)."* In fact
the key exists, VPS2 answers, and a *second* key authenticates successfully. It
still cannot read the data, for a better reason.

### 4.1 The database is not on this box

```
$ ls -la /opt/acquisition-console/data/console.db
ls: cannot access '/opt/acquisition-console/data/console.db': No such file or directory   # exit 2

$ ls -la /opt/acquisition-console
ls: cannot access '/opt/acquisition-console': No such file or directory
```

Correct — spec §1.3 L114 places `console.db` on **VPS2**.

### 4.2 The management key was revoked, and the server agrees

```
$ ls -la /root/.ssh/vps2_mgmt
ls: cannot access '/root/.ssh/vps2_mgmt': No such file or directory   # exit 2

$ ls /root/.ssh/ | grep vps2
vps2_mgmt.pub.REVOKED-20260806
vps2_mgmt.REVOKED-20260806
vps2_monitor
vps2_monitor.pub

$ ssh -i /root/.ssh/vps2_mgmt.REVOKED-20260806 -o BatchMode=yes root@167.233.145.218 'echo CONNECTED'
root@167.233.145.218: Permission denied (publickey).
```

The private key is still on disk, renamed on **2026-08-06**. It is not merely
renamed locally — the server has dropped it. This is a genuine revocation, not a
filename.

### 4.3 The surviving key authenticates and is then refused by a forced command

This is the part the brief missed, and the part that matters:

```
$ ssh -i /root/.ssh/vps2_monitor -o BatchMode=yes root@167.233.145.218 \
    'echo CONNECTED as $(whoami); ls -la /opt/acquisition-console/data/console.db'
denied: this key may only read backup status sentinels
```

VPS2 is **up, reachable, and authenticating**. `vps2_monitor` is pinned to a
forced command that refuses everything except backup-sentinel reads. So the
honest statement is not "VPS2 is unreachable" but:

> **No credential on VPS1 can read `console.db`. The management key was revoked
> on 2026-08-06 and the only surviving key is scoped to backup sentinels.**

### 4.4 What follows

1. **Directory figures are SPEC-SOURCED**, stamped `as of 2026-08-04`, with
   line references, and the card says *"not live-probeable from VPS1"* on its
   face. No live prober was built — that is scope this project has not bought.
2. **A future live Directory prober needs a credential decision from Konrad**,
   not more engineering: either a new VPS2 key scoped to a read-only query, or
   an endpoint on VPS2 that publishes the counts. Changing SSH keys is an
   escalation-before-acting item, so this task did not touch it.

---

## 5. What was built

### 5.1 R62 — Directory and YouTube are primary, asserted not eyeballed

DOM order is carried by `data-business-slot` attributes so a reviewer can check
it mechanically rather than from a screenshot:

```
["primary-directory","primary-youtube","secondary-arms","inventory"]
```

The other three arms get **one line each**, not a card. Five equal cards made a
dormant agency look like a going concern. The inventory is ordered from
`PRIMARY_BUSINESS_KEYS` rather than from the literal order of `BUSINESSES`, so
re-sorting that array cannot silently demote an arm.

### 5.2 R61 — live-probed, or dated. There is no third category

| Figure | How |
|---|---|
| YouTube job counts, stalled count, phase states | **LIVE** — `fetchPipelineBusiness()` on load, `refetchInterval` 60s, with the server's own `as_of` printed next to the `LIVE` badge |
| Directory funnel | **SPEC-SOURCED · AS OF 2026-08-04**, plus a line reference per stage |
| Axtrelis / AI OS / Personal one-liners | dated `as of` per arm |
| The 22 property status dots | `INVENTORY_AS_OF` rendered **next to every dot** as `@2026-08-04`, on every arm header, in the totals strip, and in the dot's `title` |

`INVENTORY_AS_OF` is a single exported constant. The inventory is deliberately
**not** live-probed: 22 URLs and 5 hosts per paint is scope Konrad has not
bought, and the honest cheap alternative to a probe is a date.

### 5.3 R63 — the zeroes are reported, with their source

Seven of eight Directory stages read **0**, and each states why in situ. The
headline strip says it before any chart: *"Zero outbound has ever been sent by
any system on either box, so every stage below Sourced is necessarily empty."*

**One honesty correction the brief did not ask for but the numbers demand.** The
brief says Sourced = 891. 891 is the count of rows that cleared the *enrichment
gate* (`is_indexable=1`, §1.3 L117) — which is **not** §3.2 stage 1's entry
criterion (`territory='jersey'` + target profession + `on_niche=1` + contactable
+ completeness). That ICP filter has never been counted; Jersey holds 3,949 rows
total and accountants 6,679 UK-wide (L118–119), so the true Sourced figure is
almost certainly *lower* than 891, not higher. The surface therefore renders 891
and labels it *"the nearest measured proxy… rather than promoted to a stage
count it has not earned."* Publishing 891 as Sourced unqualified would have been
the first lie on a surface built to stop lying.

### 5.4 N1 — no silent fallback on the live card

`fetchPipelineBusiness` throws on a non-2xx. The YouTube card renders three
distinct states: probing / **failed, with `GET /api/proxy/pipeline → <error>`
and a retry button** / figures. It never renders zeroes for a failure. Every
live queue currently reads 0 legitimately, which is exactly why a failure must
not be able to produce the same picture.

---

## 6. What the live probe actually returned

Measured through the harness API at 2026-08-18T20:15:09Z, worktree code against
live `content_forge`:

```
total 5 · stalled_total 5 · stall_threshold_hours 48
  idea    0  no_work_idle              — first phase, no work has been created
  script  0  no_work_idle              — nothing in any earlier phase, idle not blocked
  voice   0  no_work_idle
  assets  0  no_work_idle
  qc      5  has_work    (5 stalled)
  render  0  no_work_blocked_upstream  — 5 jobs held further up, in QC
  publish 0  no_work_blocked_upstream  — 5 jobs held further up, in QC
```

The derived next action, computed at render and never hardcoded:

> **5 of 5 jobs have not changed status in over 48h — worst is QC with 5. Clear
> that phase before queueing more work.**

Which is the true state of the arm Konrad intends to develop on first, and it
agrees with worker 7b6cccc8's independent root-cause report in the manager chat
(round 499): `dispatch-next.ts` refuses to dispatch `AWAITING_QC` to any worker.

---

## 7. Corrections to the task brief, collected

| Brief said | Measured | Effect |
|---|---|---|
| "Konrad's last human message … is 18:43:16Z, BEFORE it; there is no reply after it" | A human message exists **after** it, at 19:56:11Z — *"Drop the spend cap please."* It is not an answer. | Conclusion unchanged (default taken); the stated evidence was wrong. §1.1 |
| "VPS2 is unreachable (no `/root/.ssh/vps2_mgmt` key)" | VPS2 is reachable and `vps2_monitor` authenticates; it is refused by a **forced command**, and `vps2_mgmt` was **revoked server-side** on 2026-08-06. | Conclusion unchanged (not probeable); the reason is different and points at a credential decision, not a network problem. §4 |
| "25 properties across 5 arms" | **22** — directory 5 + axtrelis 4 + creator 7 + ai-os 3 + personal 3. The pre-existing surface already printed "22 properties". | Cosmetic; the count is computed from the array, never hardcoded, so it cannot rot. |
| §10 Q4 "Signature" vs §3.4 "first payment" | Resolved, not copied. | §3 |

---

## 8. Verification

All from this worktree. Nothing in `/opt/forge-ai-os` was written; its
`.env.local` was **read** for `AUTH_SECRET`, which N4 permits.

```
$ cd forge-control-web && pnpm install --frozen-lockfile --prod=false
Already up to date          # NOT a "- typescript" prune line
$ ./node_modules/.bin/tsc --version
Version 5.7.2
$ npx tsc --noEmit
(exit 0)

$ node scripts/checks/no-raw-colours.cjs
no-raw-colours: PASS — 222 literal(s) across 14 file(s), all accounted for
                       (176 legitimate, 46 known debt, 0 unlisted)
```

222 / 176 / 46 / 0 is **byte-identical to the pre-edit baseline** — this task
introduced zero colour literals. Every colour comes from `tokens`.

Harness, `all` (controls gate shots):

```
PASS  web server reachable — http://127.0.0.1:7840/signin → HTTP 200
PASS  api server reachable — http://127.0.0.1:7841/api/pipeline → HTTP 200
PASS  positive control — valid cookie reaches /desktop with the real nav
PASS  negative control — tampered cookie redirects to /signin
PASS  negative control — no cookie at all redirects to /signin
PASS  screenshot businesses / pipeline / money
8/8 PASS
```

The rebuilt surface, at a 2400px viewport because the desktop shell scrolls
**internally** — `fullPage: true` at the harness's 1000px viewport captures only
the viewport, which is why the harness's own shot shows just the Directory card:

```
PASS  not /signin — http://127.0.0.1:7840/desktop
PASS  surface is Businesses, not TODAY
PASS  R62 — DOM order ["primary-directory","primary-youtube","secondary-arms","inventory"]
PASS  N1  — YouTube card carries no probe-failed banner
PASS  YouTube shows the live stalled count (5 of 5, all in QC)
PASS  YouTube labels its stall threshold from the server (48h)
PASS  YouTube reports blocked-upstream, not a bare zero
PASS  R61 — Directory figures stamped SPEC-SOURCED with an as-of date
PASS  R61 — inventory dots carry @2026-08-04
PASS  R63 — zero outbound is stated
PASS  R63 — the 0.33% enrichment-gate figure is shown
PASS  R63 — Axtrelis pre-launch 5 seed orders is shown
PASS  R63 — every Directory stage below Sourced reads 0
ALL CHECKS PASS
```

That verifier is a scratch file in `/tmp` (`/tmp/p5-t3-after-shot.mjs`), not a
repo file, because `harness.mjs` belongs to task 1 and its screenshot labels are
hardcoded to `before-*`. **If this assertion set is worth keeping — and the DOM
order one is — integration should fold it into `harness.mjs` as a `shots-after`
command rather than re-deriving it.**

Screenshots. Both are beside this file and both are also under
`/opt/ai-os/uploads/d1f5b807e1ba/`; the committed copy matches its upload by
sha256, following `browser-harness.md` §6:

| File | Upload | sha256 (first 16) |
|---|---|---|
| `before-businesses.png` | round 0 | `4142fe08ff4be0f2` |
| `after-businesses.png` | `20260818T201805Z-after-businesses.png` | `9182816852d1e32f` |

---

## 9. What this task did NOT do, deliberately

- **No live prober for the 25/22-property inventory.** Explicitly out of scope;
  the honest substitute is `INVENTORY_AS_OF`, rendered next to every dot.
- **No live Directory figures.** Blocked on a credential decision (§4.4), which
  is an escalate-before-acting item.
- **No edit to** `api.ts`, `api-business.ts`, `DesktopApp.tsx`, `nav-items.ts`,
  `forge-control/src/index.ts`, or `harness.mjs`. `api-business.ts` was **read**
  for its exported types and consumed unchanged.
- **No re-ask of the spine question.** Round 0 asked; the ruling is §1.
