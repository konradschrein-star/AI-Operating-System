/**
 * Where in the Obsidian vault a writer is allowed to land — the ONE place that
 * knows whether the vault is still flat (`legacy`) or split into Konrad's side
 * and the agents' side (`split`). PLAN.md §3.5.
 *
 * THE PROBLEM. The vault root holds ~70 loose .md files Konrad typed himself,
 * mixed with `Daily/`, `Mentor/`, `AI OS/` and `Inbox/`, which no human has ever
 * written a line of — every byte in them came out of an agent. There is no way
 * to tell the two apart from the file tree, so "what did I write?" is not a
 * question his own second brain can answer. Two roots fix that:
 *
 *      Konrad/   everything he writes    (his notes, Journal/, Thoughts/Ideas)
 *      Forge/    everything an agent writes (Daily/, Mentor/, Inbox/, Seeds)
 *
 * THE FLAG IS THE WHOLE MIGRATION STORY. `VAULT_LAYOUT=legacy` (the default) is
 * today's vault, byte for byte: both roots are `""`, every resolver returns the
 * path it returns now, and lib/vault.ts's actor guard refuses nothing. Flipping
 * to `split` moves no file by itself — it only changes where NEW writes land and
 * starts refusing agent writes outside `Forge/`. The files themselves are moved
 * once, by scripts/vault-split-move.ts, on Konrad's explicit go-ahead. Procedure
 * and rollback: docs/plan/vault-split.md.
 *
 * A THIRD VALUE IS A HARD ERROR, NOT A FALLBACK. `VAULT_LAYOUT=Split`,
 * `=splt`, `=true` — anything that is not exactly `legacy` or `split` throws,
 * and it throws at MODULE LOAD (the eager check at the bottom of this file), so
 * a typo in the ecosystem file takes forge-control down at boot with the reason
 * on the log. The alternative — quietly reading an unknown value as `legacy` —
 * means an operator who believes he flipped the split has agents writing
 * unguarded into Konrad's side for as long as nobody re-reads the env.
 *
 * Everything below is read from the environment AT CALL TIME so a test can flip
 * the layout without reloading the module (the same convention vaultName() in
 * ./vault.ts follows, and the reason it is a function rather than a const).
 */

/** The only two values `VAULT_LAYOUT` may take. */
export type VaultLayoutName = "legacy" | "split";

export const VAULT_LAYOUT_NAMES: readonly VaultLayoutName[] = ["legacy", "split"];

/** The two roots, as PREFIXES: either both `""` (legacy) or both a folder name
 *  with its trailing slash (`"Konrad/"`, `"Forge/"`). A prefix, not a folder
 *  name, because every consumer concatenates rather than path.join()s — and
 *  `"" + "Daily"` is the legacy path with no special-casing anywhere. */
export interface VaultRoots {
  /** Konrad's side. Agents may never write here (see ./vault.ts). */
  human: string;
  /** The agents' side. Every agent write is confined to it under `split`. */
  agent: string;
}

/** The four places a thought can live (PLAN.md §3.2).
 *
 *  `ideas` and `seeds` are DIRECTORIES (one note per idea,
 *  `<YYYY-MM-DD>-<slug>.md`); `quotes` and `dreams` are single append-only
 *  .md FILES. That asymmetry is the plan's, not an accident of this module —
 *  it is stated here because the shape is shared with B3's lib/thoughts.ts and
 *  a consumer that path.join()s a filename onto `quotes` would write
 *  `Thoughts/Quotes.md/2026-08-25-x.md`. */
export interface ThoughtsRoots {
  /** Directory. Konrad's own ideas — his side. */
  ideas: string;
  /** Directory. Agent-derived idea seeds — the agents' side. */
  seeds: string;
  /** File. Append-only list of quotes — his side. */
  quotes: string;
  /** File. Append-only list of dreams — his side. */
  dreams: string;
}

export interface VaultLayout {
  name: VaultLayoutName;
  roots: VaultRoots;
  /** Daily notes, `<dailyDir()>/YYYY-MM-DD.md`. AGENT side: appendToDailyNote()
   *  is written by the OS, and Konrad's journal reply is a `konrad` write INTO
   *  the agent-side note, not a note of his own. */
  dailyDir(): string;
  /** Quick captures. Agent side — a capture is the OS filing something. */
  inboxDir(): string;
  /** The mentor's own memory of Konrad. Agent side, even though the subject
   *  is him: every byte was written by the mentor cron. */
  mentorDir(): string;
  /** Konrad's journal. HUMAN side — this is his writing, and the only thing an
   *  agent may do to it is read it. */
  journalDir(): string;
  thoughtsRoots(): ThoughtsRoots;
}

const DEFAULT_DAILY_DIR = "Daily";
const DEFAULT_INBOX_DIR = "Inbox";
const MENTOR_DIR = "Mentor";
const JOURNAL_DIR = "Journal";
const THOUGHTS_DIR = "Thoughts";

/** `VAULT_DAILY_DIR="Daily/"`, `"./Daily"` and `"Daily"` must all mean the same
 *  folder, and `""` must mean nothing at all. An empty or slash-only value
 *  would put `2026-08-25.md` at the vault root — a wrong destination that looks
 *  like a working write — so it throws rather than defaulting. */
function normaliseDir(raw: string | undefined, envName: string, fallback: string): string {
  const value = (raw ?? fallback).trim();
  const cleaned = value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (cleaned === "") {
    throw new Error(
      `${envName}=${JSON.stringify(raw)} resolves to an empty folder name — that would write ` +
        `notes to the vault root. Unset it to use the default ${JSON.stringify(fallback)}, ` +
        `or give it a folder.`,
    );
  }
  return cleaned;
}

/** The env value → a layout name, or a throw naming both legal values.
 *  Exported so a caller that wants to validate WITHOUT building a layout (a
 *  startup probe, a script's `--help`) shares this one parser. */
export function parseVaultLayoutName(raw: string | undefined): VaultLayoutName {
  if (raw === undefined || raw === "") return "legacy";
  if (raw === "legacy" || raw === "split") return raw;
  throw new Error(
    `VAULT_LAYOUT=${JSON.stringify(raw)} is not a vault layout. The only values are ` +
      `${VAULT_LAYOUT_NAMES.map((n) => JSON.stringify(n)).join(" and ")} (unset means "legacy"). ` +
      `Refusing to guess: reading an unknown value as "legacy" would leave agents writing ` +
      `into Konrad's side of a vault an operator believes is split.`,
  );
}

/** Frozen, and that is load-bearing rather than tidy: layout() hands this
 *  object out by reference, so without the freeze one caller writing
 *  `roots.agent = "…"` re-points EVERY later caller in the process — including
 *  the guard in ./vault.ts, which would then confine agents to a root nobody
 *  configured. Frozen, the same line throws a TypeError at the offender. */
const ROOTS: Record<VaultLayoutName, VaultRoots> = {
  legacy: Object.freeze({ human: "", agent: "" }),
  split: Object.freeze({ human: "Konrad/", agent: "Forge/" }),
};

/** The layout in force right now. Reads `VAULT_LAYOUT`, `VAULT_DAILY_DIR` and
 *  `VAULT_INBOX_DIR` on every call — cheap, and it keeps a test from having to
 *  reload half the module graph to exercise the other branch. */
export function layout(): VaultLayout {
  const name = parseVaultLayoutName(process.env.VAULT_LAYOUT);
  const roots = ROOTS[name];
  return {
    name,
    roots,
    dailyDir: () =>
      roots.agent + normaliseDir(process.env.VAULT_DAILY_DIR, "VAULT_DAILY_DIR", DEFAULT_DAILY_DIR),
    inboxDir: () =>
      roots.agent + normaliseDir(process.env.VAULT_INBOX_DIR, "VAULT_INBOX_DIR", DEFAULT_INBOX_DIR),
    mentorDir: () => roots.agent + MENTOR_DIR,
    journalDir: () => roots.human + JOURNAL_DIR,
    thoughtsRoots: () => ({
      ideas: `${roots.human}${THOUGHTS_DIR}/Ideas`,
      seeds: `${roots.agent}${THOUGHTS_DIR}/Seeds`,
      quotes: `${roots.human}${THOUGHTS_DIR}/Quotes.md`,
      dreams: `${roots.human}${THOUGHTS_DIR}/Dreams.md`,
    }),
  };
}

// The startup check. This module is imported by lib/vault.ts, which every route
// that touches the vault imports, so a junk VAULT_LAYOUT fails the process at
// boot rather than at the first capture of the day.
parseVaultLayoutName(process.env.VAULT_LAYOUT);
