/**
 * short-id.ts — eight characters that actually identify a node.
 *
 * ── THE FINDING (round 1874, finding 4) ───────────────────────────────────
 * "Every sub-agent row's tooltip shows the same id. All 7 rows' tooltips end
 * `· id toolu_01 ·` — the constant prefix, identical for `toolu_014exr6W…` and
 * `toolu_019chfnX…`."
 *
 * Two id systems meet in this UI. A RUN is a uuid, whose first eight characters
 * are as discriminating as any other eight. A SUB-AGENT is an Anthropic
 * `tool_use_id` — `toolu_01AeuQskZPyHpsYrHayvrqrT` — whose first eight
 * characters are `toolu_01` on every sub-agent that has ever run, because
 * `toolu_` is the type tag and `01` is the format version. Truncating both the
 * same way produces a label that names the FORMAT instead of the node.
 *
 * `nav-stack.ts` fixed this for the breadcrumb in round 1873 and the fix stayed
 * there, so the row tooltips two panels away kept printing the prefix. This
 * module is that same rule, in one place, imported by everything that shortens
 * an id: the team rows, the Live rows, the comms cards, the dismissal toasts.
 *
 * Pure, React-free, dependency-free — `scripts/checks/check-r1875-fixes.ts`
 * imports it directly under tsx.
 */

/** The constant head of a Task `tool_use_id`: the type tag `toolu_` and AT MOST
 *  TWO version digits (`01` on every id the API has ever minted). Everything
 *  after it is the part that differs between two sub-agents of the same run.
 *
 *  The digit count is bounded on purpose. A greedy `\d*` eats the body's own
 *  leading digits too — `toolu_014exr6W…` would lose the `4` that begins its
 *  random half and `toolu_019chfnX…` the `9`, so two ids would be shortened by
 *  different amounts and neither label would line up with the id in the
 *  breadcrumb beside it. Two digits is the version and nothing else. */
const SUBAGENT_PREFIX = /^toolu_\d{0,2}/;

/** How many characters a shortened id keeps. Eight: long enough to grep the
 *  database with, short enough to sit inside a native tooltip or a 260px
 *  header. Unchanged from every call site this module replaced. */
export const SHORT_ID_CHARS = 8;

/** True for an id minted by the Anthropic API for a Task sub-agent. Exported
 *  because "is this a run or a sub-agent" is a question two callers ask for
 *  their own reasons, and a second regex would be a second answer. */
export function isSubagentId(id: string): boolean {
  return SUBAGENT_PREFIX.test(id);
}

/**
 * The DISCRIMINATING eight characters of any node id.
 *
 * A uuid keeps its first eight. A `tool_use_id` drops the constant prefix
 * first, so `toolu_014exr6WxDpq…` → `4exr6WxD` and `toolu_019chfnXBnJa…` →
 * `9chfnXBn` — two ids that used to render identically now differ in the first
 * character. An id that is nothing but a prefix (`toolu_01`, which no API has
 * ever minted but a fixture might) keeps itself rather than becoming empty:
 * a label that names the format badly still beats a label that is blank.
 *
 * Total over any string. Never throws, never returns "".
 */
export function discriminatingId(id: string): string {
  const body = isSubagentId(id) ? id.replace(SUBAGENT_PREFIX, "") : id;
  const source = body !== "" ? body : id;
  return source.length > SHORT_ID_CHARS ? source.slice(0, SHORT_ID_CHARS) : source;
}

/**
 * The same, for a caller that may hold nothing.
 *
 * `absent` is what an empty id renders as, and it differs per surface on
 * purpose: the tooltips say "none" (a field with no value), the comms header
 * says "—" (a column with nothing in it). Both were already in the code; this
 * parameter keeps them rather than unifying two deliberate words.
 */
export function shortNodeId(
  id: string | null | undefined,
  absent: string,
): string {
  if (typeof id !== "string" || id.trim() === "") return absent;
  return discriminatingId(id);
}
