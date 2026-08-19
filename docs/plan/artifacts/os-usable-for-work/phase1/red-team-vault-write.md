# R1-red — adversarial red team of the vault write path

**Tree reviewed:** `9a4beeb76792df0dec7d57bab5581ef98282ba79` (branch `project/7851068b-vault`,
merge-base with `project/7851068b` = `3f98e67`). HEAD re-read immediately before each BLOCKER below
was written; it had not moved.

**Targets:** `forge-control/src/lib/vault.ts` (B1a, `160fb0b`) and `forge-control/src/routes/vault.ts`
(B1b, `9a4beeb`), read in full, against `02-architecture.md` §1.2 and `01-requirements.md` R1–R11.

**Isolation.** Every attack ran against a temp fixture vault (`makeFixtureVault()`) and a temp
snapshot dir, with `OBSIDIAN_VAULT_DIR` and `VAULT_SNAPSHOT_DIR` set per run. `/opt/obsidian-vault`
was never opened for writing by anything in this review; `/opt/forge-ai-os` was never touched.
Scripts are throwaway, under `/tmp/rt/`, and are reproduced inline below.

**The standard applied** (03-quality.md §3.4): *did content become unrecoverable?* Recoverable from
the snapshot store = PASS. Unrecoverable = BLOCKER. Ugly-but-recoverable = FINDING.

---

## Verdict summary

| # | Attack | Class | Recoverable? |
|---|---|---|---|
| **B-1** | Two PUTs in flight at once, one process | **BLOCKER** | **No** — acknowledged 200, in no snapshot |
| **B-2** | `appendToDailyNote` read fails with anything but ENOENT | **BLOCKER** | **No** — note replaced by the empty template, `ok:true` |
| **B-3** | Process dies during `appendToDailyNote`'s write | **BLOCKER** | **No** — note truncated to a prefix, no snapshot |
| F-1 | Symlink inside the vault escapes it (read *and* write) | FINDING (security) | Yes |
| F-2 | Zero-width-space-only body accepted | FINDING | Yes |
| F-3 | Same-millisecond snapshot name → the second edit 500s | FINDING (2 sentences) | n/a — refused |
| F-4 | §1.2 states two things that are false | FINDING (doc) | — |
| F-5 | 409 carries the whole note: 256 MB body, 3.2 s stall | FINDING | n/a |
| F-6 | Crash leaves an orphan `.tmp-` file in the vault forever | FINDING (2 sentences) | n/a |
| F-7 | Snapshot store has no retention; when it fills the disk it arms B-3 | FINDING | — |
| N-1…N-3 | Path disclosure in 500s; `readDailyNote` swallows every error | NOTE | — |

**The PUT verb itself held against every input attack in §3.4's list.** 62 hostile bodies, bases,
paths and transports were refused with the note byte-identical afterwards, including both ENOSPC
sites and an unwritable snapshot destination. The three blockers are elsewhere: two in the
pre-existing `appendToDailyNote`, whose loss paths this project's own R20 forbids and whose safety
the new module header now positively asserts, and one in the new `writeVaultFile` — a concurrency
case `02-architecture.md` §1.2 states cannot occur.

---

## BLOCKER B-1 — two PUTs in flight at once lose an acknowledged edit, with no snapshot

**File:** `forge-control/src/lib/vault.ts:380-413` (the read → compare → snapshot → rename sequence).

**Why it is not the accepted residual window.** §1.2 accepts the window between the compare and the
rename *for writers in other processes*, and grounds that on an explicit premise:

> "Single-process Node, so the read-compare-snapshot-write sequence is not interleaved with another
> request *in this process*."

That premise is false. Every step of the sequence is `await`ed, so two concurrent HTTP requests
interleave freely. Both read the same bytes, both pass compare-and-swap against the same
`base_sha256`, both snapshot *the same pre-state*, and both rename. The second rename destroys the
first writer's content — which was already acknowledged `200 {ok:true, sha256:…}` and which the
snapshot store never held.

**Failure scenario, concretely.** Konrad's editor autosaves while he presses ⌘S — or he double-clicks
Save, or the surface retries a slow request. Two PUTs, same correct base. The first returns 200 with
a sha; his paragraph is on disk for a few milliseconds; the second lands and it is gone. Both
snapshots contain the *original* note, so the undo store cannot produce the paragraph he was told
was saved.

**Reproduction** (`/tmp/rt/attack-concurrent.ts`, run 5×):

```ts
const put = (content: string) => app.request(new Request("http://x/api/vault/file", {
  method: "PUT", headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: "Daily/2026-08-18.md", content, base_sha256: sha(ORIG) }),
}));
const [a, b] = await Promise.all([put(KONRAD), put(OTHER)]);   // same base, both valid
```

**Observed** — 3 of 5 runs:

```
PUT #1 (Konrad's paragraph): 200 {"ok":true,...,"sha256":"0df465908dd0…","bytes":88}
PUT #2 (the second save)   : 200 {"ok":true,...,"sha256":"dee10033e359…","bytes":85}
on disk now          : "- [ ] a second save, milliseconds later"
snapshots taken      : 2
snapshot bodies      : ["", ""]        <- both hold the ORIGINAL, neither holds #1
#1 was ACKNOWLEDGED 200 with sha 0df465908dd0… → GONE: not on disk and in NO snapshot — UNRECOVERABLE
```

The other 2 of 5 runs collided on the snapshot filename inside one millisecond and returned 500
(see F-3) — i.e. the current behaviour under concurrency is *either* a silent lost edit *or* a 500,
selected by timing.

**Smallest change that closes it.** An in-process serialisation point keyed on the resolved absolute
path — a `Map<string, Promise<unknown>>` chain around the body of `writeVaultFile`, roughly ten
lines. This is **not** the lock file §1.2 rejected: it needs no on-disk state and therefore no
stale-lock policy, and it closes the in-process case completely. The cross-process window stays open
and stays accepted (see F-4).

---

## BLOCKER B-2 — a read failure that is not ENOENT replaces the daily note with the empty template

**File:** `forge-control/src/lib/vault.ts:161-166`, then `:170`.

```ts
try {
  content = await fs.readFile(abs, "utf8");
} catch {                       // <- every error, not just ENOENT
  content = DAILY_TEMPLATE(date);
  created = true;
}
…
await fs.writeFile(abs, next, "utf8");     // writes the template OVER the real note
```

A bare `catch` treats *any* read failure as "today's note does not exist yet", then writes an empty
template over the note that is sitting right there. There is no snapshot on this path, the call
resolves `{ok:true, created:true}`, and the caller is told a note was *created*.

This is the exact defect **R20** exists to forbid — "the vault verbs **hard-error**. No `catch {}`
that returns a default" — and `appendToDailyNote` is a vault verb. It is also the accident **R7**
and mechanism 2 of the undo contract were written to prevent, reached through the append verb
instead of the PUT verb.

**Triggers that are real, not theoretical:** an EIO from a failing disk; ENOMEM under memory
pressure (forge-control is one process that also runs the cron tick, the vault sync and Telegram
delivery); `ERR_STRING_TOO_LONG` / `ERR_FS_FILE_TOO_LARGE` once a note passes V8's string limit —
measured at ~512 MB in F-5, and the PUT verb happily writes a 200 MB note today (§ "attacks that
held", S10).

**Reproduction** (`/tmp/rt/attack-catch.ts`). The injection technique is the committed suite's own —
`vault.test.ts:382` monkeypatches `fs.rename` to throw EXDEV; this makes the *read* fail the way a
disk does:

```ts
nodeFs.promises.readFile = async (p, ...rest) => {
  if (String(p) === abs) { const e = new Error("EIO: simulated read failure"); e.code = "EIO"; throw e; }
  return realRead(p, ...rest);
};
await V.appendToDailyNote({ section: "Notes", text: "a captured thought" });
```

**Observed** (identical for EIO, EACCES, ERR_FS_FILE_TOO_LARGE, ENOMEM):

```
daily note before: 4725 bytes, 128 lines
read fails with EIO → append RESOLVED ok, created=true
  note is now 76 bytes (4649 BYTES DESTROYED)
  content now: "# 2026-08-18\n\n## Tasks\n\n## Notes\n- 22:42 — a captured thought\n\n## Journal\n"
  snapshot store: EMPTY — UNRECOVERABLE
```

**Smallest change that closes it:** rethrow anything whose `code` is not `ENOENT`, exactly as
`writeVaultFile:385` already does four hundred lines below in the same file.

```ts
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  content = DAILY_TEMPLATE(date); created = true;
}
```

---

## BLOCKER B-3 — a crash during the append truncates the note, and nothing snapshotted it

**File:** `forge-control/src/lib/vault.ts:170` — `await fs.writeFile(abs, next, "utf8")`.

`writeFile` opens the destination with `O_TRUNC`. For the whole duration of the write the note is a
prefix of itself on disk, and there is no snapshot and no temp file. A crash, an OOM kill, a `pm2
restart` landing at the wrong instant, or a power loss inside that window leaves the note
permanently truncated. **R6** names this failure verbatim — "*Fails when:* An in-place write exists,
so a crash mid-write truncates a note."

**Reproduction** (`/tmp/rt/attack-crash3.ts`): a 43 MB daily note; a single-process child
(`node --import tsx`, so nothing outlives the signal) calls `appendToDailyNote`; the parent SIGKILLs
the whole process group at a sweep of delays and then verifies via `/proc/*/environ` that no process
survived to keep writing.

**Observed:**

```
kill@1150ms survivors=0 delta=33 completed
kill@1200ms survivors=0 43400045 -> 13000704 TRUNCATED, -30399341 bytes
            | strict prefix of the original: true | snapshot store: EMPTY — UNRECOVERABLE
kill@1250ms survivors=0 delta=33 completed
```

30 MB of the note gone, the survivor is a strict prefix of the original, snapshot store empty.
(One hit in 28 samples — the write is a short slice of the call. It is a race, not a certainty; it
is also the only write in this module with no undo behind it.)

**Note on the test that should have caught this.** `vault.test.ts:417` — "*by source inspection: the
destination is reached only by rename*" — slices the source to the body of `writeVaultFile` alone
(`:418-422`), and then flips its own regex against the string literal
`'await fs.writeFile(abs, next, "utf8")'` (`:429`). That literal *is* line 170. The counterexample
is used as the assertion's negative control while being scoped out of the assertion's subject. The
test is honest about what it checks; the **module header is not**, which is why this is a blocker
rather than a note — see below.

**Smallest change that closes it:** route line 170 through the same temp-file + fsync + rename
sequence `writeVaultFile` already uses (extract `:404-413` into a private `atomicWrite(abs, content)`
and call it from both). The bytes that land are unchanged, so R11's byte-level characterisation test
(`vault.test.ts:581`, `:600`) still passes.

### The R11 / R20 tension the corpus does not resolve — a decision for the manager

B-2 and B-3 live in code this diff did not modify, and **R11** requires `POST /append` to "behave
identically to before this project". **R20** requires the vault verbs to hard-error with no
swallowing catch. Both cannot hold for `vault.ts:161`.

They are nevertheless blockers *on this phase* because commit `160fb0b` added a **new, module-wide,
load-bearing claim** that these two paths falsify — `vault.ts:10`:

> `NO CONTENT THIS MODULE EVER REMOVES IS UNRECOVERABLE.`

and `:13`, "All three are mandatory; none is optional, best-effort, or skippable". That sentence is
the entire justification for giving up the append-only contract. As written it is false for
`appendToDailyNote`, in two demonstrated ways. Shipping it is worse than shipping no claim, because
the claim is what the next agent will trust.

The fix for B-3 is byte-neutral and compatible with R11. The fix for B-2 changes one error path from
"destroy the note and report success" to "throw" — which is a behavioural change R11 forbids on its
face and R20 demands. **Recommended:** take both fixes and record the R11 exception in
`04-phases.md` §10, because R11's purpose is to protect append-or-create *semantics*, not to
preserve a data-destroying fallback. Fallback if that is refused: fix B-3 only and narrow the
`:10` claim to the PUT verb explicitly.

---

## FINDING F-1 (security) — a symlink inside the vault escapes it, for reads and for writes

**File:** `forge-control/src/lib/vault.ts:67-78` (`resolveInVault`) — `path.resolve()` is lexical and
does not resolve symlinks. `resolveOrRefuse` reuses it faithfully (R9), so the hole is in the shared
guard, and both the new verbs inherit it. **R9's stated guarantee — "traversal rejected" / "escapes
vault → 400" — does not hold in the presence of a symlink.**

Content stays recoverable (the snapshot is taken before every one of these writes), so by §3.4's
standard this is a FINDING and not a blocker. It is listed first among findings because
forge-control runs as **root**.

**Reproduction** (`/tmp/rt/attack-fs.ts`, S1–S4) and **observed**:

| Attack | Result |
|---|---|
| `ln -s /etc/hostname $VAULT/leak.md`; `GET /api/vault/file?path=leak.md` | **200, file contents returned.** Arbitrary read of any file the root process can open, behind any `*.md` link name. |
| `ln -s /tmp/outdir $VAULT/escape`; `PUT escape/victim.md` | **200. `/tmp/outdir/victim.md` overwritten** — a write outside the vault. Restricted to files that already exist and end `.md`; the base sha needed is handed out for free by the GET above. |
| `ln -s $VAULT/.trash $VAULT/t`; `PUT t/deleted.md` | **200. `.trash/deleted.md` overwritten** — the dot-segment guard bypassed by one symlink. |
| `ln -s /tmp/outside.md $VAULT/linked.md`; `PUT linked.md` | 200; the *symlink* is replaced by a regular file (`rename` does not follow), target intact. Ugly, harmless. |

The attacker needs to create a symlink in the vault, so this is not remote-reachable — but
`/opt/obsidian-vault` is written by LiveSync from Konrad's devices and by every agent on this box,
which is a wider set of writers than "nobody".

**Smallest change:** `await fs.realpath(path.dirname(abs))` (the parent, so a not-yet-created file
still works) and re-assert containment before the read and before the write. Two lines in
`resolveOrRefuse`, and it fixes GET and PUT together. Secondary: the snapshot flattens
`escape/victim.md` to `escape__victim.md.<ms>.md`, which records nothing about where the bytes
actually came from — restoring such a snapshot needs the symlink to still exist.

## FINDING F-2 — a zero-width-space-only body is accepted and blanks the note

**File:** `forge-control/src/lib/vault.ts:365` — `content === "" || /^\s*$/.test(content)`.

JS `\s` covers U+FEFF, so a BOM-only body *is* refused (verified). It does **not** cover U+200B
(ZWSP), U+200C, U+200D or U+2060. A body of a single U+200B passes the guard, lands as three bytes, and
the note renders blank in Obsidian.

```
content: BOM only (U+FEFF)   | 400 | changed=false | "empty content refused: a whitespace-only body …"
content: ZWSP only (U+200B)  | 200 | changed=true  | {"ok":true,…,"bytes":3}
```

Recoverable — the snapshot is intact — so this is a FINDING. **Two sentences; fold it into B1a**
rather than seeding a fix cycle: strip `/[\u200B-\u200D\u2060\uFEFF]/g` from a copy of the body
before applying the existing `^\s*$` test.

## FINDING F-3 — two edits to one note inside the same millisecond: the second gets a 500

`vault.ts:321` names the snapshot `<flat>.<Date.now()>.md` and `:326` writes it `wx`. Two edits to
one path in the same millisecond collide, and the second is refused with a 500 reading "vault
snapshot failed … THE NOTE WAS NOT WRITTEN". Failing closed is the right instinct, but a legitimate
edit is lost to a 500 the UI has no retry story for, and the same collision is how B-1 sometimes
manifests. **Two sentences; fold into B1a** — append a short random suffix to the snapshot name, as
`writeVaultFile:404` already does for the temp file. (`a/b.md` vs `a__b.md` flatten-collision, same
mechanism, same outcome — verified, S8.)

## FINDING F-4 — §1.2 asserts two things that are not true

1. *"Single-process Node, so the read-compare-snapshot-write sequence is not interleaved with another
   request in this process."* — false, and it is the root cause of B-1. Every step is `await`ed.
2. *"The snapshot makes the worst case recoverable, which is the right trade."* — false for the case
   it is defending. I was told to raise the accepted residual window only if I could show the
   snapshot does not cover it. It does not: the snapshot holds the bytes read *before* the compare,
   so an agent's write that lands inside the window is overwritten and appears in no snapshot.
   Measured (`attack-fs.ts` S9): `AGENT CONTENT RECOVERABLE FROM ANY SNAPSHOT: false`,
   `PRE-STATE V1 RECOVERABLE FROM SNAPSHOT: true`.

I am **not** asking for the lock file — the trade is still right for a single-operator system. I am
asking for the sentence to say what is actually true: *the pre-edit state is always recoverable; a
third-party write that lands inside the window is not.* One paragraph in `02-architecture.md` §1.2.

## FINDING F-5 — a 409 on a large note serialises the whole note

`routes/vault.ts:186-195` returns `current_content` verbatim (correctly — R3 requires it). Measured
(`/tmp/rt/attack-409.ts`) on the single process that also runs the cron tick, the vault sync and
Telegram delivery:

```
256 MB note → 409, 409 body 256.0 MB, 3201ms, rss +224 MB
512 MB      → exceeds V8's max string length (which is what arms B-2)
```

Not loss. Worth a cap: return `current_content` up to some size and a
`current_content_truncated: true` flag above it, so the conflict UI degrades instead of the process.

## FINDING F-6 — a crash during the temp write leaves an orphan in the vault forever

`attack-crash.ts` C2: SIGKILL during `handle.writeFile` leaves
`Notes/big.md.tmp-1328992-2b5ef015ac5f`, 60 MB, in Konrad's vault. The note itself is intact and the
cleanup path at `:416` is correct — it just cannot run when the process is gone. The name does not
end in `.md`, so `syncVaultNotes` (`db/memory.ts:247`) skips it and Obsidian will not index it; the
cost is disk and confusion, not correctness. **Two sentences; fold into B1a** — sweep `*.tmp-*`
older than an hour on the next write to that directory, or accept it and say so in the header.

## FINDING F-7 — the snapshot store has no retention, and a full disk arms B-3

§1.2: "never (retention is a later decision)". Every PUT copies the *whole* pre-state; the 200 MB
note in S10 costs 200 MB per edit. When the store fills the filesystem the PUT verb fails **safely**
— verified, E1/E2 below — but `appendToDailyNote` at line 170 does not have that protection, so disk
exhaustion is a plausible real-world route into B-3. Retention can stay a later decision; the
coupling should be in the header.

## NOTES

- **N-1.** A path containing a NUL byte, or a 5000-character path, returns 500 with the **absolute**
  vault path in the error body (`…open '/opt/obsidian-vault/Notes/x\x00.md'`). Path disclosure on an
  authenticated surface; cosmetic here, worth a scrub if this API is ever exposed.
- **N-2.** `readDailyNote` (`vault.ts:214`) swallows every read error and returns `content: null`, so
  a transient EIO renders as "no daily note today". Read-only, no loss; same R20 smell as B-2.
- **N-3.** `resolveInVault:69` — `seg.startsWith(".") && seg !== ""` — the second clause is dead
  (`"".startsWith(".")` is `false`). Harmless.

---

## Attacks that held — the note was byte-identical afterwards

Every row below was run and the destination re-read after each attempt. `/tmp/rt/attack-route.ts`
drives the real Hono router; the happy-path control at the end of that script proves the negatives
are not vacuous.

**Bodies** (path and base both valid): `""` → 400 · `"   \n\n \t"` → 400 · `" "` → 400 · `null` →
400 · field missing → 400 · `42` → 400 · `["a"]` → 400 · `{"a":1}` → 400 · `true` → 400 · U+FEFF
only → 400.

**Transport:** no body → 400 · empty body → 400 · `{not json` → 400 · `null` → 400 · a top-level
array → 400 · `42` → 400 · `"hello"` → 400 · `true` → 400. No malformed body ever became a write
attempt.

**Bases:** missing · `""` · `null` · `"deadbeef"` · the correct hash **uppercased** · the correct
hash with a trailing space · a number · 63 hex + `g` → all **400**. A base from a **different file**,
a base that is the sha of the **new** content, and the sha of the empty string → all **409** with
`current_sha256` *and* `current_content` in the body (R3).

**Paths:** `../etc/passwd.md` · `/etc/passwd.md` · an absolute path to an existing file outside the
vault · `Daily/../../x.md` · `.obsidian/app.json` · `.trash/deleted.md` ·
`Notes/../.trash/deleted.md` · `..\..\x.md` · `Empty.txt` · no extension · `Notes` · `Notes/` ·
`Daily/./x.md` · `//etc/passwd.md` · `Notes/..%2f..%2fx.md` · a number · `null` · an array · `""` ·
`"   "` → all **400**. NUL-in-path and a 5000-char path → 500, nothing written (N-1). The control
file outside the vault was byte-identical at the end of the run. `.MD` uppercase resolves and is
correctly refused as non-existent rather than created.

**Snapshot destination unwritable, root-proof** (`attack-fs.ts` S5): `VAULT_SNAPSHOT_DIR` under a
parent that is a regular file → ENOTDIR, which root cannot defeat.
→ `THE NOTE WAS NOT WRITTEN`, `NOTE UNCHANGED: true`, no stray `.tmp-`.

**ENOSPC on a real 1 MB tmpfs** (`attack-enospc.ts`):

```
E1 — full disk during the SNAPSHOT write:
     "vault snapshot failed … THE NOTE WAS NOT WRITTEN: ENOSPC" | content intact: true | stray .tmp-: []
E2 — full disk during the TEMP-FILE write (snapshot succeeded first):
     "ENOSPC: no space left on device, write" | content intact: true | stray .tmp-: []
     snapshot present: ["Daily__2026-08-18.md.<ms>.md"]
```

**Large bodies** (`attack-fs.ts` S10): a 200 MB body → 200 in 1337 ms, 209 715 200 bytes on disk,
snapshot taken. Ten million lines (50 MB) → 200 in 2298 ms. Neither skipped the snapshot, which is
the specific failure R4 names.

**Ordering, by source reading:** `writeVaultFile` refuses the path (`:353`), refuses a non-string or
blank body (`:359-369`), refuses a missing/malformed base (`:372-378`), reads (`:383`), compares
(`:394`), snapshots (`:400`), and only then opens a temp file **in the destination's own directory**
(`:404` — `${abs}.tmp-…`, so no cross-device rename), fsyncs (`:409`), closes, renames (`:413`). The
destination is never opened with truncation. `fs.rename(` appears exactly once in the module. No
catch in `routes/vault.ts` returns a default: every one carries the upstream message and a status
(N1/R20 satisfied **at the route layer** — the violation is in the lib, at B-2).

---

## Gates

`scripts/checks/gates-808.sh --strict` (the repo-wide suite named in `docs/plan/03-quality.md`; the
per-project `docs/plan/os-usable-for-work/03-quality.md` exists and was used for the attack list in
§3.4 and the fixture rule in §1.2). **25 gates, 23 EXECUTED, 2 SKIPPED-by-design** (23/24 are the
browser gates, skipped because `--browser` was not requested), **RED: 0, exit 0**. Gate 20 is
`pnpm test` — the forge-control unit suite, including the 1 154 lines of `vault.test.ts` +
`vault-routes.test.ts` added by B1a/B1b — green.

`grep -rn "/opt/obsidian-vault"` over `vault.test.ts`, `vault-routes.test.ts`, `vault-fixture.ts`,
`memory-index-health.test.ts` → no matches. No lane-1 test touches the real vault (03-quality §1.2).

**Write-set audit** — declared on the task rows, compared against `git log --name-only`:

| Task | Declared | Touched | |
|---|---|---|---|
| B1a `78105d41` | `lib/vault.ts`, `lib/vault.test.ts`, `lib/vault-fixture.ts` | the same 3 | ✅ |
| B1b `13276a41` | `routes/vault.ts`, `lib/vault-routes.test.ts` | the same 2 | ✅ |
| B1c `8f37b32a` | 5 paths | the same 5 | ✅ |
| B1d `de2112c3` | 6 paths | the same 6 | ✅ |

No undeclared writes.

**Live-checkout cleanliness.** `git -C /opt/forge-ai-os status --porcelain` returned
` M forge-control-web/app/desktop/chat/AssistantThread.tsx` at the start of this review and **empty**
when re-run immediately before this verdict was written. Recorded because the check is meant to be
falsifiable: the final state passes, and the transient dirt is named so a later reader can tell
whether it recurred.

---

RED-TEAM VERDICT: 3 BLOCKERS

---

## APPENDIX — resolution, round 100 fix cycle 1 (2026-08-19)

Appended, not edited: the report above is the record of what the tree looked like at
`9a4beeb`/`01fa802` and stays as written.

All three blockers and every folded finding are closed on `project/7851068b-vault`. The evidence —
each defect reproduced against the committed tree **first**, then the identical harness re-run against
the fix — is in `fix-cycle-1-vault-write.md` beside this file.

| R1-red item | Status |
|---|---|
| B-1 concurrent PUTs lose an acknowledged edit | **CLOSED** — `serialiseOnPath()`, per resolved absolute path. 5/5 runs: one 200, one 409, one snapshot |
| B-2 bare catch destroys the daily note | **CLOSED** — ENOENT-only. 4 245 B → 4 245 B, and the call throws |
| B-3 non-atomic append | **CLOSED** — `atomicWrite()` shared by both verbs. Smallest size observed on disk during a 40 MB append: 40 000 048 B |
| F-1 symlink escape (security) | **CLOSED** — realpath containment in `resolveOrRefuse`, read and write |
| F-2 zero-width body | **CLOSED** — folded, as instructed |
| F-3 same-millisecond snapshot collision | **CLOSED** — folded; 8 hex of randomness in the snapshot name |
| F-5 409 serialises a 256 MB note | **CLOSED** — folded; 8 MiB cap, announced via `current_content_truncated` + `current_bytes` |
| F-6 orphan `.tmp-` after a crash | **CLOSED** — folded; `sweepOrphanTempFiles()`, own name shape only, older than an hour |
| F-4 §1.2 asserts two false things | **CLOSED** — both sentences quoted and corrected in `02-architecture.md` §1.2 |
| N-2 `readDailyNote` swallows every error | **CLOSED** — same ENOENT-only guard, under the same R11 ruling |
| N-1 path disclosure in 500s | **NOT FIXED**, deliberately — cosmetic on an authenticated surface, and the path is the diagnostic R20 exists to keep |
| N-3 dead clause in `resolveInVault:69` | **NOT FIXED** — harmless, and touching it is diff noise |
| F-7 snapshot retention | **NOT FIXED** — a policy decision, not a defect. The coupling is now stated in the module header; B-3, which it armed, is closed regardless |

**The R11/R20 decision the report escalated was ruled by the operator: fix B-2.** R11 protects
append-or-create *semantics*, not a data-destroying fallback. The exception is recorded in
`04-phases.md` §10.1 with its reasoning, its exact scope, and a statement of what did **not** change.

**The `vault.ts:10` claim is narrowed.** The module-wide sentence "NO CONTENT THIS MODULE EVER REMOVES
IS UNRECOVERABLE" is gone. In its place: what each verb guarantees, and an explicit **"what is NOT
claimed"** list naming the cross-process window, the scope of the realpath check, and the absent
snapshot retention policy.

**The test the report called out is rewritten, not patched.** `vault.test.ts`'s source inspection had
scoped itself to `writeVaultFile`'s body and then used line 170 — the defect — as its own negative
control. It now measures the whole module: every direct write to a destination must carry `flag:
"wx"`, and the only non-exclusive path is `atomicWrite`, which reaches the destination by `rename`
alone.
