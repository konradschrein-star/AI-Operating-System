/**
 * Source hygiene: no file under `forge-control/src/` may contain a raw NUL
 * (0x00) byte.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * WHY THIS FILE EXISTS — round 214 finding 2, and it is an INSTRUMENT defect,
 * not a runtime one. `normaliseWritePath()`'s doc-comment in
 * `lib/task-graph.ts` wrote the string it refuses (`"a<NUL>b"`) with a literal
 * NUL instead of an escape. `tsc` and `node --test` both parsed the file
 * happily, 970 tests stayed green, and nothing misbehaved at runtime. What
 * broke was every text tool that reads the tree:
 *
 *     $ file forge-control/src/lib/task-graph.ts
 *       … data                                   (not "JavaScript source")
 *     $ grep -rn "depends_on" forge-control/src --include='*.ts'
 *       grep: src/lib/task-graph.ts: binary file matches
 *       218 lines returned; with -a, 255 — 37 lines silently hidden
 *     $ git grep -n "TODO(R12-retire)" -- forge-control/src/lib/task-graph.ts
 *       exit=1                                   (four occurrences exist)
 *
 * That last command is `03-quality.md` §3.2's Phase-2 retirement gate, and the
 * NF6 audit phases 5–8 inherit reads the same marker. A gate that answers "no
 * occurrences" when four exist is precisely the class this project was ordered
 * to stop shipping: INSTRUMENTS LIE BEFORE CODE DOES. One byte turned two
 * documented review gates into silent false negatives, and the only reason it
 * was caught is that a reviewer's very first grep answered `binary file
 * matches` instead of a line.
 *
 * So the guard belongs where `pnpm test` runs it, not where the next reviewer's
 * first grep happens to notice it.
 *
 * DELIBERATELY A BYTE SCAN, NOT A LINT RULE. The property is textual and has
 * nothing to do with TypeScript: it is "the tree stays greppable". Reading the
 * bytes is the only test that cannot itself be fooled by the thing it is
 * looking for — a regex over a decoded string would depend on the decoder, and
 * a `grep` shelled out from here would inherit the very blindness being
 * checked. `readFileSync` with no encoding returns a Buffer; `indexOf(0)` reads
 * it as bytes.
 *
 * SCOPE: every file under `forge-control/src/`, not just `*.ts` — and every file
 * under `docs/plan/`. At the time of writing the source tree holds 122 `.ts`,
 * 3 `.json` and 1 `.md`, no binaries; a fixture that legitimately needs a NUL
 * belongs in a `.bin` beside its test, where an explicit exemption below would
 * have to name it. There are none today, and the empty exemption list is the
 * point: adding to it is a decision someone has to write down.
 *
 * THE PLAN CORPUS IS IN SCOPE BECAUSE IT WAS BITTEN TOO, in the same fix cycle
 * that added this file. Writing up finding 2 put a raw NUL into
 * `evidence/phase3-fix-1.md` — the escape in the sentence *describing* the
 * escape — and `grep -n` immediately answered `binary file matches` on the
 * evidence document. The corpus is exactly what a gating reviewer greps: R29's
 * `depends_on` sweep, the `TODO(R12-retire)` marker, `check-corpus-map.py`'s
 * requirement scan. A blinded document is the same instrument defect as a
 * blinded module, so the guard covers both rather than covering the one that
 * happened to be reported.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** src/lib → src. */
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));
/** src/lib → src → forge-control → repo root → docs/plan. Same hop count as
 *  `migrations.test.ts`'s `MIGRATIONS_DIR`, which is the precedent for a lint
 *  in this directory reading up out of the package. */
const PLAN_DIR = fileURLToPath(new URL("../../../docs/plan", import.meta.url));

/**
 * Paths (relative to the scanned root) permitted to contain a NUL byte. EMPTY,
 * and a reviewer should treat a non-empty list as a claim needing a reason
 * beside it.
 */
const EXEMPT: ReadonlySet<string> = new Set<string>();

/** Every file under `dir`, recursively, as paths relative to `dir`. */
function walk(dir: string, relative = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Extensions a reviewer greps. Used by the `docs/plan/` arm ONLY: that tree
 * carries several hundred `.png` screenshots as review artifacts, and a PNG
 * begins with a NUL by specification (`\x89PNG` then `IHDR`'s length word). A
 * scan that flagged them would be an unsatisfiable gate — the exact thing this
 * round amended elsewhere — so the corpus arm asks the narrower question that
 * is actually at stake: are the files a reviewer greps still greppable?
 *
 * The `src/` arm needs no such list. It has no binaries, and keeping it
 * extension-blind means a `.bin` appearing there is caught rather than
 * silently skipped.
 */
const GREPPABLE = [".md", ".py", ".sql", ".sh", ".ts", ".tsx", ".json", ".txt", ".yml", ".yaml"];

/**
 * @param root      absolute directory to scan
 * @param minFiles  the walk must find at least this many, or the scan is
 *                  reporting a pass it never earned
 * @param mustReach one path the walk must contain, so a refactor that moves the
 *                  tree cannot silently narrow the test's reach to nothing
 * @param textOnly  restrict to `GREPPABLE` extensions — see that constant
 */
function assertNoNulBytes(root: string, minFiles: number, mustReach: string, textOnly = false): void {
  const walked = walk(root);
  const files = textOnly ? walked.filter((f) => GREPPABLE.some((ext) => f.endsWith(ext))) : walked;

  // A scan that scanned nothing would certify anything (INSTRUMENTS LIE BEFORE
  // CODE DOES). Both assertions below run BEFORE the verdict, not after it.
  assert.ok(files.length >= minFiles, `walked only ${files.length} file(s) under ${root}`);
  assert.ok(files.includes(mustReach), `the walk under ${root} did not reach ${mustReach}`);

  const offenders: string[] = [];
  for (const rel of files) {
    if (EXEMPT.has(rel)) continue;
    const bytes = readFileSync(join(root, rel));
    const at = bytes.indexOf(0);
    if (at !== -1) {
      // Byte offset AND line, because that is what a reader needs to open it:
      // the line is where the editor goes, the offset is what survives the file
      // being edited above it (round 214 finding 2 was reported both ways).
      const line = bytes.subarray(0, at).toString("utf8").split("\n").length;
      offenders.push(`${rel}: NUL at byte offset ${at} (line ${line})`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "a raw NUL byte makes grep report the file as binary, which silently blinds " +
      "03-quality.md §3.2's TODO(R12-retire) gate, R29's depends_on sweep and " +
      "check-corpus-map.py's requirement scan. Write it as \\u0000:\n  " +
      offenders.join("\n  "),
  );
}

test("no file under forge-control/src/ contains a raw NUL byte", () => {
  assertNoNulBytes(SRC_DIR, 100, "lib/task-graph.ts");
});

test("no GREPPABLE file under docs/plan/ contains a raw NUL byte", () => {
  // The corpus a gating reviewer greps. See the header: writing up finding 2
  // put a NUL into `evidence/phase3-fix-1.md` and turned the evidence document
  // itself into `binary file matches`. Text types only — the tree also holds
  // several hundred `.png` review artifacts, every one of which legitimately
  // starts with a NUL. See `GREPPABLE`.
  assertNoNulBytes(PLAN_DIR, 10, "engine-task-graph/01-requirements.md", true);
});
