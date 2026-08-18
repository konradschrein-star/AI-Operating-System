# S-B — `obsidian://` URI semantics and vault-name resolution

Scout: S-B · Phase 0 (round 99) · consumed by Phase 1 (R18, R19)
Date: 2026-08-18

## Sources

- **Primary, canonical:** raw markdown source of the official Obsidian Help page, fetched directly
  from Obsidian's publish backend (bypasses the JS-rendered wrapper and any summarizer):
  `curl -s "https://publish-01.obsidian.md/access/f786db9fac45774fa4f0d8112e232d67/Extending%20Obsidian/Obsidian%20URI.md"`
  — this is the exact markdown Obsidian Publish serves for
  `https://help.obsidian.md/Extending+Obsidian/Obsidian+URI` (which 301-redirects to
  `https://obsidian.md/help/Extending+Obsidian/Obsidian+URI`, a client-rendered Obsidian Publish
  site — the HTML shell alone carries no page text, which is why the raw `.md` fetch was used
  instead of screenshotting the rendered page). Full text saved at `/tmp/obsidian-uri.md` on this
  box; quoted verbatim below. Also screenshotted for the record:
  `/opt/ai-os/uploads/2a6a5bac3022/20260818T190942Z-obsidian-uri-docs.png` (rendered page, confirms
  the same content visually).
- **Local, live:** `/opt/obsidian-vault` on this box (`basename` → `obsidian-vault`), and the
  absence of any `obsidian.json` app-config file anywhere on this filesystem (`find / -iname
  obsidian.json` → no hits) — this box runs no Obsidian desktop app, only the vault-file tree
  LiveSync replicates into.

---

## 1. Does `file=` take the path with or without `.md`? Does Obsidian accept both?

**Both are accepted.** Verbatim from the doc's Parameters section for the `open` action:

> `file` can be either a file name, or a path from the vault root to the specified file. If the
> file extension is `md`, the extension can be omitted.

So `file=Daily/2026-08-18` and `file=Daily/2026-08-18.md` both resolve to the same note. Obsidian
does not require the extension to be stripped, it only permits omitting it.

**Recommendation for `obsidianUri()` (R18/R19):** keep the `.md` extension. Reasons:
- It matches the vault-relative path exactly as it exists on disk and as every other part of this
  codebase already stores it (`vault_path` columns, `resolveInVault()` inputs) — zero transformation,
  zero surface for a stripping bug.
- Stripping is not free in this vault: `.excalidraw.md` files (15 of them, per `00-vision.md §2.1`)
  have a compound extension. A naive `path.replace(/\.md$/, '')` still works on those (removes only
  the trailing `.md`, leaving `.excalidraw`), but a naive "split on last dot" implementation would not.
  Keeping the extension sidesteps the whole class of bug.
- The requirement only asks for *deterministic*, not for stripped — R19's failure mode is "the `.md`
  extension is stripped from `file=`" listed as one of two ways to fail, not a mandate to strip.

## 2. How does `vault=` resolve? Folder name vs. internal ID — which is robust across machines?

Verbatim:

> `vault` can be either the vault name or the vault ID[^1].
>
> [^1]: Vault ID is the random 16-character code assigned to the vault, for example
> `ef6ca3e3b524d22f`. This ID is unique per folder on your computer. The ID can be found by opening
> the vault switcher and clicking "Copy vault ID" in the context menu for the desired vault.

Examples given: `obsidian://open?vault=my%20vault` (name) and `obsidian://open?vault=ef6ca3e3b524d22f`
(ID) are both valid and shown as equivalent forms.

**Vault ID is not usable here, and this is the decision this scout answers for R19.** The footnote
says the ID is "assigned to the vault" and "unique per folder on your computer" — it is generated and
stored by each local Obsidian *application* install when that folder is first opened as a vault (in
that install's own app-level `obsidian.json`, which lives outside the vault folder itself — confirmed
by its absence from `/opt/obsidian-vault` and from this entire filesystem: no vault ever loaded on
this box, so no ID has ever been minted here). Consequences:
- **This server can never know the ID**, because no Obsidian app runs here to mint one. Any ID
  server-side code emitted would be fabricated.
- **The ID Konrad's laptop assigned to its local copy of this vault is unknowable from here** and,
  per the same footnote, is tied to *that folder on that computer* — if he ever re-clones the
  LiveSync replica to a new path, a new ID may be assigned.
- Vault ID is therefore link-target information that only exists client-side, per machine. A
  server-generated URI cannot embed it correctly.

**Vault name is the only field this codebase can respond with, and it carries its own hazard:**
LiveSync replicates file *contents*, not the local Obsidian vault registration or the folder name
Konrad chose for the replica on his laptop. `/opt/obsidian-vault`'s basename is `obsidian-vault`
(confirmed: `basename /opt/obsidian-vault` → `obsidian-vault`), and the sync-conflict artifacts
(`.obsidian/*.sync-conflict-20260702-*.json`) confirm LiveSync is live against this exact folder —
but nothing enforces that the laptop's replica folder is also named `obsidian-vault`. If it is named
anything else, a URI built with `vault=obsidian-vault` will make Obsidian either open a *different,
wrong* vault of that name (if one exists) or show a "vault not found" dialog — either way, a link
that silently fails or silently misleads.

**This is exactly why R19 specifies `OBSIDIAN_VAULT_NAME` as configuration, not a hardcoded guess,
defaulting to the basename of `OBSIDIAN_VAULT_DIR`.** The default (`obsidian-vault`) is correct
*today* because that is this box's real folder name — but the UI must display the configured name
(R19: "exposed read-only on the API so the UI can display it") so Konrad can see at a glance whether
it matches his laptop's folder, and override the env var if his laptop names the replica differently
rather than the product silently emitting a broken link. State this caveat in the UI copy next to
"Open in Obsidian", per the brief's A2 instruction ("say so in the UI rather than shipping a link
that silently fails").

## 3. Encoding — space, `&`, `#`, `?`, `+`, em dash, and the test path

Verbatim warning from the doc:

> Ensure that your values are properly URI encoded. For example, forward slash characters `/` must
> be encoded as `%2F` and space characters must be encoded as `%20`.
>
> This is especially important because an improperly encoded "reserved" character may break the
> interpretation of the URI.

Confirmed by the doc's own `new` action example, which percent-encodes a path separator inside a
value: `obsidian://new?vault=my%20vault&file=path%2Fto%2Fmy%20note` → creates the note at
`path/to/my note` — i.e. **`/` inside a parameter value is encoded as `%2F` and Obsidian decodes it
back into a directory separator.** This matters directly for this project: every vault-relative path
here (`AI OS/Specs/...`, `Daily/...`) contains `/` as a directory separator *inside* the `file=`
value, so those slashes must be percent-encoded too, not left literal. `encodeURIComponent()` does
this correctly (it encodes `/`, space, `&`, `#`, `?`, and `+`); `encodeURI()` does not (it treats `/`
`&` `#` `?` `+` `$` `,` `:` `;` `=` `@` as reserved-and-preserved, because it assumes its input is
already a full URI, not one component of one) — this is the exact bug R18 names as a failure mode.

**`+` deserves its own note, UNVERIFIED against Obsidian's own parser specifically:** the general web
convention (`application/x-www-form-urlencoded`, used by `URLSearchParams` and Node's `querystring`)
decodes a literal, unencoded `+` in a query value as a space. The Obsidian help page does not state
which decoder Obsidian's Electron main process uses for its custom-protocol handler, so whether an
unencoded `+` in `file=` would come out as `+` or as a space in the opened path is **UNVERIFIED** from
documentation alone. This is precisely why R18's failure mode lists it explicitly ("`+` is treated as
a space") and why the fix is unconditional: percent-encode `+` as `%2B` via `encodeURIComponent()`
regardless of how Obsidian would have resolved the ambiguity, so the ambiguity never reaches it.

### Worked example — real path, both outputs

Path under test (from the brief and from R60's business-plan doc):
`AI OS/Specs/Directory + Business Plan Hub — Business Model.md`
Vault name: `obsidian-vault` (no special characters, unaffected by either function).

**Correct final URI** (`encodeURIComponent()` on `vault` and on `file` independently, `.md` kept):

```
obsidian://open?vault=obsidian-vault&file=AI%20OS%2FSpecs%2FDirectory%20%2B%20Business%20Plan%20Hub%20%E2%80%94%20Business%20Model.md
```

**What naive `encodeURI()` produces instead** (the wrong answer phase 1's unit test must also assert
against, per the brief):

```
obsidian://open?vault=obsidian-vault&file=AI%20OS/Specs/Directory%20+%20Business%20Plan%20Hub%20%E2%80%94%20Business%20Model.md
```

Note what survives unencoded in the wrong version: the two `/` path separators (which `encodeURI`
treats as URI structure, not data — harmless here only because Obsidian happens to also accept literal
`/` as a separator in some contexts, but not guaranteed and not what the doc's own example encodes),
and the literal `+` (which risks decoding as a space per §3's `+`/space note above). Both are
Directory + Business Plan Hub — Business Model.md`'s vault-relative path.

### Character-by-character table (produced by Node's `encodeURIComponent`/`encodeURI`, not hand-derived)

| Char | Unicode | `encodeURIComponent` | `encodeURI` | Notable |
|---|---|---|---|---|
| ` ` (space) | U+0020 | `%20` | `%20` | both agree |
| `/` | U+002F | `%2F` | `/` (unencoded) | `encodeURI` treats as URI structure — wrong inside a param value, per doc's own `path%2Fto%2F...` example |
| `+` | U+002B | `%2B` | `+` (unencoded) | `encodeURI` leaves literal; risk of space-decoding, see §3 |
| `—` (em dash) | U+2014 | `%E2%80%94` | `%E2%80%94` | both agree (non-ASCII always encoded by both) |

`&` and `#` do not occur in the worked path above; the brief also names `40_Life Knowledge/x & y.md`
as a second reference case — computed the same way, for phase 1's test table:

| Input | `encodeURIComponent` | `encodeURI` |
|---|---|---|
| `&` (U+0026) | `%26` | `&` (unencoded) |
| `#` (U+0023) | `%23` | `#` (unencoded) |

Full URI for that second vector (`file=`, vault `obsidian-vault`):

- Correct: `obsidian://open?vault=obsidian-vault&file=40_Life%20Knowledge%2Fx%20%26%20y.md`
- Wrong (`encodeURI`): `obsidian://open?vault=obsidian-vault&file=40_Life%20Knowledge/x%20&%20y.md`
  — note the literal `&` here does not merely fail to open the right note, it **terminates the `file`
  parameter early and starts a new (bogus) query parameter named `y.md`'s neighbor** because `&` is
  the query-parameter separator. This is the single most destructive case in the table: not "wrong
  file", but "no `file` parameter at all" — Obsidian would open the vault picker or the last-active
  note instead, with the failure looking like nothing happened rather than like an error.

### Round-trip check (assert-able in the phase 1 unit test, per R18)

```
$ node -e 'const p="AI OS/Specs/Directory + Business Plan Hub — Business Model.md";
console.log(decodeURIComponent(encodeURIComponent(p)) === p)'
true
```
`encodeURIComponent` → `decodeURIComponent` round-trips exactly for every character in both worked
paths; `encodeURI` → `decodeURIComponent` does not round-trip the `+` (decodes to `+`, not space,
under `decodeURIComponent` specifically — but this is *not* the decoder Obsidian is confirmed to use,
see the UNVERIFIED note above) and does not need to round-trip the `/` since it was never touched —
which is exactly the bug, not a reassurance.

## 4. Is there a documented way to detect from a browser whether Obsidian is installed?

**No. Confirmed absent, not merely unfound.** The fetched page (§ full text in `/tmp/obsidian-uri.md`
on this box) covers URI format, all six actions (`open`, `new`, `daily`, `unique`, `search`,
`choose-vault`), the Hook integration, x-callback-url parameters, shorthand formats, and a
"Troubleshooting → Register Obsidian URI" section for OS-level protocol registration (Windows/macOS
automatic; Linux requires a manual `.desktop` file with `Exec=executable %u`) — and none of it
addresses browser-side detection of whether a `obsidian://` handler is registered at all. The
Troubleshooting section is about the *reverse* direction (getting the OS to route the scheme to
Obsidian), not about a web page introspecting whether that routing exists.

Browsers also give no standard API for this: there is no query-only equivalent of
`navigator.registerProtocolHandler` (that API *registers* a handler for the calling page's own
origin, it cannot ask "is scheme X already handled by anything"), and the folklore workaround
(open the custom-scheme URI, start a timer, and treat a `blur`/`visibilitychange` event within the
window as "it opened" vs. the timer firing first as "nothing handled it") is a browser behavioural
inference, not anything Obsidian documents or guarantees — it is unreliable across Chrome/Firefox/
Safari versions and popup-blocker settings, and is exactly the kind of guess this project's
`00-vision.md` warns against ("an unverified guess costs more than the five minutes of browsing you
skipped").

**Conclusion for phase 1: ship the on-screen caveat, not a detector.** "Open in Obsidian" should
render as a link Konrad can click, captioned with a static, always-shown note (not a dynamic
installed/not-installed check) — e.g. "opens in the Obsidian desktop app if installed on this
machine" — per the brief's A2 instruction. This is a **caveat**, not a determination; do not build
speculative blur-timer detection, it is not a real signal and its failure mode is a false negative on
a real Obsidian install (a slow window switch reads as "not installed").

---

## Summary for the Phase 1 planner

| # | Question | Answer |
|---|---|---|
| 1 | `.md` in `file=`? | Both accepted; **keep the extension** in `obsidianUri()` for determinism and to avoid a compound-extension edge case (`.excalidraw.md`) |
| 2 | `vault=` resolution | Name or 16-char ID; **use name** (`OBSIDIAN_VAULT_NAME`, default = basename of `OBSIDIAN_VAULT_DIR` = `obsidian-vault`) — ID is generated per-install client-side and is unknowable from this server, confirmed by the total absence of any `obsidian.json` on this box |
| 3 | Encoding | `encodeURIComponent()` on `vault` and `file` **independently**, never `encodeURI()` on the assembled string; a literal `&` in an unencoded path doesn't just point at the wrong note, it truncates the URI at the query-separator and drops `file=` entirely |
| 4 | Detect Obsidian installed? | No documented way; no reliable browser API either. Ship a static caveat string, not a detector |

**Worked test vectors for phase 1's unit test** (both in the table above and reproducible via the
`node -e` one-liners in this document):
1. `AI OS/Specs/Directory + Business Plan Hub — Business Model.md` → correct + wrong URIs, full table
2. `40_Life Knowledge/x & y.md` → correct + wrong URIs, including the query-truncation failure mode

Recommended `obsidianUri()` signature (matches R18 exactly, implementation not built by this scout —
research only): `obsidianUri({vaultName, vaultRelativePath}) => \`obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(vaultRelativePath)}\``
