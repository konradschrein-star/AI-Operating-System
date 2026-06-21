/*
 * Lightweight fuzzy subsequence scorer for picker filtering.
 *
 * Ported verbatim from NousResearch/hermes-agent web/src/lib/fuzzy.ts (MIT)
 * for the v1.6 phase 4 slash menu in forge-control-web. Same scoring
 * heuristics — word boundary, contiguous run, prefix, exact match — but
 * with no dependencies so it's safe to ship into a Next.js client bundle.
 *
 * Matches a query as an ordered subsequence of the target (so `g4o` matches
 * `gpt-4o`) and scores by match quality so callers can rank results.
 */

export interface FuzzyMatch {
  /** Total score; higher is better. */
  score: number;
  /** Indices into the original (non-lowercased) target that were matched. */
  positions: number[];
}

const WORD_BOUNDARY = /[-_/.\s]/;

function isBoundary(target: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const prev = target[index - 1];
  if (WORD_BOUNDARY.test(prev)) {
    return true;
  }
  const cur = target[index];
  return (
    prev === prev.toLowerCase() &&
    cur !== cur.toLowerCase() &&
    cur === cur.toUpperCase()
  );
}

export function fuzzyScore(target: string, query: string): FuzzyMatch | null {
  if (!query) {
    return { score: 0, positions: [] };
  }
  const lowerTarget = target.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let prevIndex = -1;
  let searchFrom = 0;

  for (const ch of lowerQuery) {
    const idx = lowerTarget.indexOf(ch, searchFrom);
    if (idx < 0) return null;
    positions.push(idx);
    score += 1;
    if (prevIndex >= 0 && idx === prevIndex + 1) {
      score += 5;
    } else if (prevIndex >= 0) {
      score -= Math.min(idx - prevIndex - 1, 3);
    }
    if (isBoundary(target, idx)) score += 3;
    if (idx === 0) score += 5;
    prevIndex = idx;
    searchFrom = idx + 1;
  }

  if (
    positions.length &&
    positions[0] === 0 &&
    positions[positions.length - 1] === positions.length - 1
  ) {
    score += 8;
  }
  if (lowerTarget === lowerQuery) score += 20;
  score -= lowerTarget.length * 0.01;

  return { score, positions };
}

export function fuzzyScoreMulti(
  target: string,
  query: string,
): FuzzyMatch | null {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { score: 0, positions: [] };
  let score = 0;
  const positionSet = new Set<number>();
  for (const token of tokens) {
    const match = fuzzyScore(target, token);
    if (!match) return null;
    score += match.score;
    for (const pos of match.positions) positionSet.add(pos);
  }
  return { score, positions: [...positionSet].sort((a, b) => a - b) };
}

export interface RankedItem<T> {
  item: T;
  score: number;
  positions: number[];
}

export function fuzzyRank<T>(
  items: readonly T[],
  query: string,
  toText: (item: T) => string,
): RankedItem<T>[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return items.map((item) => ({ item, score: 0, positions: [] }));
  }
  const ranked: Array<RankedItem<T> & { index: number }> = [];
  items.forEach((item, index) => {
    const match = fuzzyScoreMulti(toText(item), trimmed);
    if (match) {
      ranked.push({
        item,
        score: match.score,
        positions: match.positions,
        index,
      });
    }
  });
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.map(({ item, score, positions }) => ({
    item,
    score,
    positions,
  }));
}
