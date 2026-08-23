/**
 * check-phase3-placeholders.ts — R40's nav marker, as assertions.
 *
 * PHASE 3 of os-usable-for-work (round 300, workstream `surfaces`). Konrad read
 * GOALS, JOURNAL, MAP and LIBRARY as "don't work quite yet" because each renders
 * a tidy card that looks like a feature which failed to load. B3a measured all
 * four and found no route, no table and no data module behind any of them —
 * docs/plan/artifacts/os-usable-for-work/phase3/surface-determinations.md.
 *
 * The screen now says so in words. This file asserts the OTHER half: that the
 * nav marks exactly those four, so the truth is visible before the click.
 *
 * ROUND 8: GOALS RETIRED. The determination above was true when B3a measured
 * it and is false now — `main` (553fa38) shipped a real `GoalsSurface` and
 * Konrad used it the night of 2026-08-18. `EXPECTED_UNBUILT` below is now
 * three keys, not four; `journal`, `library` and `map` are still genuinely
 * unbuilt and stay flagged. A dedicated flip (§1a) proves the audit still
 * catches `goals` if it is ever re-marked while `GoalsSurface` exists.
 *
 * WHAT IS HERE AND WHAT IS NOT
 *   Here: everything about `NAV.unbuilt` that is pure — the set, its membership
 *   in the nav model, its absence from the built entries, and its reachability
 *   from the phone sheet. No React: a check that reads a list of 17 strings must
 *   not pull in @assistant-ui, three.js and Excalidraw to do it (nav-items.ts's
 *   own rule, stated at the top of that file).
 *
 *   Not here: that the marker RENDERS at all three nav sites, and that the words
 *   "not built yet" land above the fold. Those are browser measurements and live
 *   in docs/plan/artifacts/os-usable-for-work/phase3/verify-phase3.cjs.
 *
 * THE FLIP, AND WHY IT IS HALF THIS FILE
 *   An assertion that passes at every fixture value proves nothing, and this
 *   fleet has been bitten by exactly that. So `auditUnbuiltMarks` is run twice:
 *   once over the real `NAV`, where it must report nothing, and again over local
 *   copies that have been deliberately broken — a BUILT key flagged, a genuinely
 *   unbuilt key unflagged, a marked key stranded off the phone menu — where it
 *   must name the specific key. A guard tested only in its passing state is a
 *   guard that has never been tested.
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx \
 *     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-phase3-placeholders.ts
 */

import {
  NAV,
  SURFACES,
  UNBUILT_NAV_KEYS,
  mobileNavDestinations,
  unbuiltNavKeys,
  type NavItem,
  type Surface,
} from "../../forge-control-web/app/desktop/nav-items";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}

/* ── The claim, written once ──────────────────────────────────────────────────
 *
 * These three and no others. Sorted, so the assertion is about the SET and not
 * about the order entries happen to sit in inside `NAV` — reordering the rail
 * is not a defect and must not fail this file.
 *
 * `goals` is deliberately absent as of round 8: `main` shipped a real
 * `GoalsSurface` and it is no longer unbuilt. `search` is deliberately absent
 * too, for a different reason — it is a placeholder key but not a NAV entry,
 * and its backend is built, mounted and answering live (determinations §5), so
 * marking it would be a second wrong label rather than a fix. Both are
 * asserted below, not just omitted. */
const EXPECTED_UNBUILT: readonly Surface[] = ["journal"];

const sorted = (keys: readonly Surface[]): Surface[] => [...keys].sort();

interface Audit {
  /** Flagged `unbuilt` but not in `EXPECTED_UNBUILT` — a marker on a built
   *  destination, which is how a marker on everything becomes a marker on
   *  nothing. */
  markedButBuilt: Surface[];
  /** In `EXPECTED_UNBUILT` but carrying no flag — the defect this round exists
   *  to remove, returning quietly. */
  unmarkedButUnbuilt: Surface[];
  /** Flagged, but the phone menu cannot reach it. Round 1872 found 11 of 14
   *  destinations unreachable at 390px; a marker Konrad cannot see is the same
   *  bug wearing a different hat. */
  unreachableOnPhone: Surface[];
  /** Flagged, but not a member of the surface union at all. */
  notASurface: Surface[];
}

/**
 * The whole contract, over a list that is passed IN rather than imported — so
 * the same code can be run against a deliberately broken copy and be shown to
 * discriminate.
 */
function auditUnbuiltMarks(
  items: readonly NavItem[],
  phoneDestinations: readonly Surface[],
): Audit {
  const marked = unbuiltNavKeys(items);
  const markedSet = new Set<Surface>(marked);
  const expected = new Set<Surface>(EXPECTED_UNBUILT);
  const reachable = new Set<Surface>(phoneDestinations);
  return {
    markedButBuilt: sorted(marked.filter((k) => !expected.has(k))),
    unmarkedButUnbuilt: sorted(
      EXPECTED_UNBUILT.filter((k) => !markedSet.has(k)),
    ),
    unreachableOnPhone: sorted(marked.filter((k) => !reachable.has(k))),
    notASurface: sorted(marked.filter((k) => !SURFACES.includes(k))),
  };
}

const CLEAN: Audit = {
  markedButBuilt: [],
  unmarkedButUnbuilt: [],
  unreachableOnPhone: [],
  notASurface: [],
};

/** A copy of `NAV` with one entry's `unbuilt` flag forced on or off. Deep enough
 *  to be independent: the real `NAV` is exported as a mutable array and a test
 *  that edited it in place would poison every assertion after it. */
function navWith(key: Surface, unbuilt: boolean): NavItem[] {
  return NAV.map((n) => {
    if (n.key !== key) return { ...n };
    const copy: NavItem = { ...n };
    if (unbuilt) copy.unbuilt = true;
    else delete copy.unbuilt;
    return copy;
  });
}

/* ════════════════════════════════════════════════════════════════════════════
 * 1 — the set is exactly the one remaining unbuilt key
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── the unbuilt set ─────────────────────────────────────────");

check(
  "NAV marks exactly journal",
  sorted(unbuiltNavKeys()),
  ["journal"],
);
check("…one of them, not more", unbuiltNavKeys().length, 1);
check(
  "the exported constant is the same derivation, not a second list",
  sorted(UNBUILT_NAV_KEYS),
  sorted(unbuiltNavKeys(NAV)),
);
check(
  "every marked key is a real NAV key",
  unbuiltNavKeys().filter((k) => !NAV.some((n) => n.key === k)),
  [],
);
check(
  "every marked key is a real surface",
  unbuiltNavKeys().filter((k) => !SURFACES.includes(k)),
  [],
);

console.log("\n── and NOT on the built ones ───────────────────────────────");

/* Named individually rather than only as a set difference: these are the
 * surfaces that render real components and that Konrad uses daily. If one of
 * them ever acquires a marker, the failing line should say which. `goals`
 * joined this list at round 8; `library` and `map` joined when they were built. */
for (const built of [
  "today",
  "inbox",
  "chat",
  "tasks",
  "pipeline",
  "library",
  "money",
  "businesses",
  "skills",
  "memory",
  "live",
  "control",
  "autonomy",
  "automation",
  "settings",
  "goals",
  "map",
] as const) {
  check(
    `${built.toUpperCase()} is built and carries no marker`,
    NAV.find((n) => n.key === built)?.unbuilt ?? false,
    false,
  );
}
check(
  "16 of the 17 NAV entries carry nothing at all",
  NAV.filter((n) => n.unbuilt === undefined).length,
  16,
);
check(
  "SEARCH is not in NAV, so it cannot be marked — it is a different defect",
  NAV.some((n) => n.key === "search"),
  false,
);
check(
  "…though it is still a surface the app can be put into",
  SURFACES.includes("search"),
  true,
);

/* ════════════════════════════════════════════════════════════════════════════
 * 2 — the marker is reachable where the rail is not
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── every marked entry is reachable on a phone ──────────────");
{
  const reachable = new Set(mobileNavDestinations());
  check(
    "all marked are in the phone sheet's destinations",
    unbuiltNavKeys().filter((k) => !reachable.has(k)),
    [],
  );
  check(
    "…named: journal",
    ["journal"].map((k) => reachable.has(k as Surface)),
    [true],
  );
  check(
    "…and library, map, goals, no longer marked, are still reachable in their own right",
    ["library", "map", "goals"].every((k) => reachable.has(k as Surface)),
    true,
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * 3 — the audit over the real model reports nothing
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── auditUnbuiltMarks(NAV) ──────────────────────────────────");
check(
  "the real nav model is clean on all four counts",
  auditUnbuiltMarks(NAV, mobileNavDestinations()),
  CLEAN,
);

/* ════════════════════════════════════════════════════════════════════════════
 * 4 — THE FLIP. The same audit, over deliberately broken copies.
 *
 * Without this section every assertion above would still pass if
 * `auditUnbuiltMarks` returned four empty arrays unconditionally.
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── the flip: a BUILT key marked unbuilt is caught ──────────");
{
  const doctored = navWith("today", true);
  check(
    "the fixture really is different from NAV",
    sorted(unbuiltNavKeys(doctored)),
    ["journal", "today"],
  );
  const audit = auditUnbuiltMarks(doctored, mobileNavDestinations());
  check("…and the audit names TODAY", audit.markedButBuilt, ["today"]);
  check("…and does not invent a second complaint", audit.unmarkedButUnbuilt, []);
  check(
    "the whole audit, so a silent extra field cannot hide",
    audit,
    { ...CLEAN, markedButBuilt: ["today"] },
  );
}

console.log("\n── §1a: the flip: GOALS re-marked unbuilt is caught ────────");
{
  /* The exact regression round 8 exists to prevent: GOALS was one of the
   * original four, `main` shipped a real `GoalsSurface`, and if this key is
   * ever re-flagged — a bad merge, a stale rebase, a copy-paste from an old
   * NAV — the screen would tell Konrad his own feature "is not built yet"
   * again. This must fail loudly, the same way TODAY does above. */
  const doctored = navWith("goals", true);
  check(
    "the fixture really is different from NAV",
    sorted(unbuiltNavKeys(doctored)),
    ["goals", "journal"],
  );
  const audit = auditUnbuiltMarks(doctored, mobileNavDestinations());
  check("…and the audit names GOALS", audit.markedButBuilt, ["goals"]);
  check("…and does not invent a second complaint", audit.unmarkedButUnbuilt, []);
  check(
    "the whole audit, so a silent extra field cannot hide",
    audit,
    { ...CLEAN, markedButBuilt: ["goals"] },
  );
}

console.log("\n── the flip: LIBRARY and MAP re-marked unbuilt are caught ──");
{
  const doctoredLib = navWith("library", true);
  check(
    "the fixture really is different from NAV",
    sorted(unbuiltNavKeys(doctoredLib)),
    ["journal", "library"],
  );
  const auditLib = auditUnbuiltMarks(doctoredLib, mobileNavDestinations());
  check("…and the audit names LIBRARY", auditLib.markedButBuilt, ["library"]);

  const doctoredMap = navWith("map", true);
  check(
    "the fixture really is different from NAV",
    sorted(unbuiltNavKeys(doctoredMap)),
    ["journal", "map"],
  );
  const auditMap = auditUnbuiltMarks(doctoredMap, mobileNavDestinations());
  check("…and the audit names MAP", auditMap.markedButBuilt, ["map"]);
}

console.log("\n── the flip: PIPELINE, the built surface next to LIBRARY ───");
{
  /* PIPELINE sits in the same nav group as LIBRARY and is genuinely built and
   * wired to content_forge.content_jobs. It is the most plausible mis-mark. */
  const audit = auditUnbuiltMarks(navWith("pipeline", true), mobileNavDestinations());
  check("the audit names PIPELINE", audit.markedButBuilt, ["pipeline"]);
}

console.log("\n── the flip: an unbuilt key losing its marker is caught ────");
{
  const audit = auditUnbuiltMarks(navWith("journal", false), mobileNavDestinations());
  check("the audit names JOURNAL", audit.unmarkedButUnbuilt, ["journal"]);
  check("…and nothing else", audit.markedButBuilt, []);
}

console.log("\n── the flip: a marker the phone cannot reach is caught ─────");
{
  /* The failure mode round 1872 actually shipped: the destination exists in the
   * model and the phone menu never renders it. Here the sheet's coverage is
   * truncated rather than the nav, because `mobileNavDestinations()` reads the
   * real NAV and cannot be doctored from outside. */
  const strandedSheet = mobileNavDestinations().filter((k) => k !== "journal");
  const audit = auditUnbuiltMarks(NAV, strandedSheet);
  check("the audit names JOURNAL", audit.unreachableOnPhone, ["journal"]);
  check("…and still reports the set itself as correct", audit.markedButBuilt, []);
}

console.log("\n── the flip: a marker on a non-surface is caught ───────────");
{
  /* Not reachable through the type system — `key` is a `Surface` — so it is
   * constructed the only way a real regression would arrive: by a cast at the
   * boundary, as a hand-edited list or a stale build would produce. */
  const bogus = [
    ...NAV.map((n) => ({ ...n })),
    { key: "kanban" as Surface, label: "KANBAN", group: "work", unbuilt: true } as NavItem,
  ];
  const audit = auditUnbuiltMarks(bogus, mobileNavDestinations());
  check("the audit names KANBAN as not a surface", audit.notASurface, ["kanban"]);
  check("…and as unreachable on a phone", audit.unreachableOnPhone, ["kanban"]);
}

console.log("\n── the real NAV is unchanged by all of the above ───────────");
check(
  "no fixture mutated the imported model",
  sorted(unbuiltNavKeys(NAV)),
  ["journal"],
);
check("…and it still has 17 entries", NAV.length, 17);

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — phase 3 placeholders (R40)`,
);
process.exit(failures === 0 ? 0 : 1);
