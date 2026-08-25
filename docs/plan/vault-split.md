# Vault split — the operator procedure

**Status: the mechanism is built, the vault is NOT split.** `VAULT_LAYOUT`
defaults to `legacy`, every root is `""`, the actor guard refuses nothing and
no file has moved. Flipping it is the five steps below, and every one of them
is reversible. Do not run step 2 without Konrad's explicit go-ahead — it is the
only irreversible-feeling step in the list, and even it has an undo.

Companion documents:

- `docs/plan/vault-split-manifest.md` — WHAT moves where, and why, per folder
  and per Excalidraw file. Its §7 JSON block is what the mover reads.
- `PLAN.md` §3.5 — the design and its rejected alternatives.
- `forge-control/src/lib/vault-layout.ts` — the flag and the folder resolvers.
- `forge-control/src/lib/vault.ts` — the actor guard and the `author: forge`
  stamp.

## What the split is

Two roots inside `/opt/obsidian-vault`:

| root | holds | who writes it |
|---|---|---|
| `Konrad/` | his loose root notes, `20_Coding`, `30_YouTube`, `_Templates`, `_Attachements`, `Excalidraw` (his drawings), `Journal/`, `Thoughts/Ideas`, `Thoughts/Quotes.md`, `Thoughts/Dreams.md` | Konrad, and routes acting for him (`actor: "konrad"`) |
| `Forge/` | `Daily/`, `Mentor/`, `Inbox/`, `AI OS/`, `90_AI_OS/`, `Thoughts/Seeds`, the canvas smoke fixtures | every agent |

Under `VAULT_LAYOUT=split`, `lib/vault.ts` throws on an `agent` write whose path
is outside `Forge/`, and stamps `author: forge` into the frontmatter of any note
it creates for an agent. Under `legacy` neither happens and the bytes written
are identical to what shipped before the flag existed.

## Before you start

1. **Read the manifest's §6 "Ask Konrad".** One entry — `90_AI_OS/` (56 files)
   — is classified `likely-ask`, and the mover **refuses to run at all** while
   an `ask` entry is unanswered. `--include-ask` is you asserting he answered.
2. **Nothing else may be writing the vault.** LiveSync/Syncthing keeps running
   (it follows renames), but a cron mid-write during the rename window is a lost
   note. Run the move between mentor crons, and check
   `pm2 jlist | grep -c forge-executor` is idle-ish first.
3. **Hermes is a second writer this guard cannot see.** The laptop-side Hermes
   obsidian skill uses its own env var (`OBSIDIAN_VAULT_PATH`) and its own file
   tools — `lib/vault.ts` never runs in that process. If Hermes points at this
   vault, it will keep writing wherever its skill says until that skill is
   updated. Manifest §4 flags it; confirm before you flip.

## Step 1 — dry-run the move, read every line

```bash
cd /opt/forge-ai-os                       # the live checkout, at the merged tip
npx tsx scripts/vault-split-move.ts                  # refuses: 1 ask entry
npx tsx scripts/vault-split-move.ts --include-ask    # the full plan
```

The dry run touches nothing and prints, per entry, `from → to`, the file count,
the bytes and the confidence. Entries derived from the manifest's §7 root-note
rule (the ~70 loose `.md` files at the vault root, which the JSON deliberately
does not enumerate) are printed with `DERIVED by the §7 root-note rule` — read
those especially, since no human classified them one at a time.

Measured 2026-08-25 against the real vault: **97 moves, 348 files, 129.9 MB**;
4 no-ops (the empty designed folders) and 3 skips (`.obsidian`, `.stfolder`,
`.trash`, never moved whatever a manifest says).

## Step 2 — the move (needs Konrad's word)

```bash
npx tsx scripts/vault-split-move.ts --apply --i-have-konrads-go --include-ask
```

`--apply` without `--i-have-konrads-go` exits non-zero having done nothing.
What it does, in order:

1. Re-reads the manifest and rebuilds the plan. A path in the manifest that is
   no longer in the vault aborts the run — a stale manifest is re-classified,
   not worked around.
2. Copies **every file it is about to move** to
   `/opt/ai-os/vault-snapshots/vault-split-move/<UTC stamp>/`, preserving the
   pre-move relative path, and verifies each copy's size. A snapshot failure
   aborts before anything moves.
3. Writes `reversal.json` beside the snapshots **before the first rename**, so a
   run that dies halfway still leaves the undo.
4. Renames, one entry at a time, `fs.rename()` only — no `git mv`, no index, and
   never onto an existing path.

## Step 3 — repoint the two hardcoded paths

`forge-control/src/routes/map.ts:73-74` holds two literal vault paths:

```ts
const OVERVIEW_NOTE = "90_AI_OS/Konrad Projects Overview.md";
const MASTER_MAP_NOTE = "90_AI_OS/Infrastructure - Master Map.md";
```

They become `Forge/90_AI_OS/…`. The route treats a missing file as a hard error,
so this breaks loudly rather than silently — but it breaks. Grep once more
before restarting: `grep -rn "90_AI_OS\|\"Daily/\|\"Inbox/" forge-control/src`.

## Step 4 — flip the flag and restart

Set it in forge-control's pm2 environment — `forge-control/ecosystem.config.cjs`,
which holds **two** `env:` blocks (lines 52 and 100 as of 2026-08-25): one for
the `forge-control` API and one for `forge-executor`. Both write to the vault.
Add the line to BOTH, beside the `OBSIDIAN_VAULT_DIR` already there:

```js
VAULT_LAYOUT: 'split',
```

Setting only one of them is the failure mode to watch for: the API writes to
`Forge/Daily` while every worker run still writes to `Daily/`, and neither
errors.

Any other value — `Split`, `true`, a typo — throws at module load and
forge-control does not come up, with the reason on the pm2 log. That is
deliberate: a mistyped flag read as `legacy` would leave agents writing
unguarded into Konrad's side of a vault you believe is split.

```bash
/opt/ai-os/scripts/safe-restart.sh          # never `pm2 restart forge-executor`
```

## Step 5 — verify

```bash
# 1. A capture lands on the AGENT side.
curl -sX POST http://127.0.0.1:7700/api/vault/append \
  -H 'content-type: application/json' \
  -d '{"section":"Notes","text":"split verification"}'
#    → {"ok":true,"path":"Forge/Daily/<today>.md", ...}   ← the path is the assertion

# 2. That note exists, and carries the stamp if the run created it.
head -4 "/opt/obsidian-vault/Forge/Daily/$(date +%F).md"

# 3. Konrad's side is intact and untouched by the fleet.
ls /opt/obsidian-vault/Konrad | head

# 4. The map route still resolves its two notes (step 3 done right).
curl -s http://127.0.0.1:7700/api/map | head -c 200
```

If step 5.1 answers with a `Daily/…` path instead of `Forge/Daily/…`, the
process did not pick up the env — check `pm2 jlist` for the actual environment
rather than the config file.

## Rollback

Two independent levers; use the smallest one that fixes the problem.

**A. Flag only** (the vault has moved, something in the app is wrong). Set
`VAULT_LAYOUT=legacy`, `safe-restart.sh`. Writers go back to `Daily/`, `Inbox/`
— which no longer exist at those paths, so `appendToDailyNote()` recreates
`Daily/` at the root. Fine for an hour, wrong as a resting state: either fix
forward or do B as well.

**B. Undo the move.**

```bash
npx tsx scripts/vault-split-move.ts --reverse \
  /opt/ai-os/vault-snapshots/vault-split-move/<stamp>/reversal.json
```

Renames every entry back, skipping any that never happened, and refusing to
rename onto a path that exists again. It leaves the now-empty `Konrad/` and
`Forge/` directories behind — this script has no delete verb; `rmdir` them
yourself. The snapshots are never touched by the reversal: if a note was edited
after the move and the rename back is refused, the pre-move bytes are still
sitting in the snapshot directory.

Then unset `VAULT_LAYOUT` (or set `legacy`), revert step 3, `safe-restart.sh`.

## What is deliberately NOT automated

- **Wikilinks are not rewritten.** Obsidian resolves `[[folder/note]]` by
  suffix match, so nesting a folder one level deeper breaks none of the six
  path-qualified links in the vault (manifest §5, checked). If that ever stops
  being true, it is a separate, reviewed change — not a regex over his notes.
- **Existing notes are not stamped.** `author: forge` goes onto notes the OS
  creates from the flip onwards. Backfilling it would mean rewriting the
  frontmatter of files an agent classified but did not write, which is exactly
  the guess the manifest's `ask` confidence exists to avoid.
- **`.trash` stays where it is.** Moving Obsidian's trash relocates deleted
  notes under a new root, where Obsidian will not find them to restore.
