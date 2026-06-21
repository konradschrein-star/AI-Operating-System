/**
 * Minimal 5-field cron parser. Computes the next firing time given an
 * expression + a reference timestamp. No external dep — we only need:
 *
 *   - `*`             (any value in field range)
 *   - `N`             single number
 *   - `A-B`           inclusive range
 *   - `* /N`          step (every N units)
 *   - `A,B,C`         list
 *   - combinations    `1-5,10,X/2` (where X is a wildcard or range)
 *
 * Fields, in order:    minute(0-59)  hour(0-23)  dom(1-31)  month(1-12)  dow(0-6, Sun=0)
 *
 * Behaviour matches POSIX cron for the supported subset. Year is unrolled by
 * the matchAt walker — we cap forward search at 2 years to avoid runaway on
 * impossible expressions (e.g. Feb 31).
 */

interface FieldSpec {
  values: Set<number>;
  min: number;
  max: number;
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // dom
  [1, 12], // month (1-based)
  [0, 6], // dow (0=Sun)
];

function parseField(raw: string, [min, max]: [number, number]): FieldSpec {
  const values = new Set<number>();
  for (const piece of raw.split(",")) {
    const seg = piece.trim();
    if (!seg) throw new Error(`empty piece in field "${raw}"`);
    // step "X/Y"
    let step = 1;
    let base = seg;
    if (seg.includes("/")) {
      const [b, s] = seg.split("/", 2);
      base = b;
      step = Number(s);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`invalid step in "${seg}"`);
      }
    }
    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = min;
      hi = max;
    } else if (base.includes("-")) {
      const [lstr, hstr] = base.split("-", 2);
      lo = Number(lstr);
      hi = Number(hstr);
    } else {
      lo = Number(base);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`non-integer bound in "${seg}"`);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`field "${seg}" out of range [${min},${max}]`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, min, max };
}

interface ParsedCron {
  minute: FieldSpec;
  hour: FieldSpec;
  dom: FieldSpec;
  month: FieldSpec;
  dow: FieldSpec;
}

/** Parse a 5-field cron expression. Throws on malformed input. */
export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `cron expression must have 5 space-separated fields, got ${parts.length}: "${expr}"`,
    );
  }
  return {
    minute: parseField(parts[0], FIELD_RANGES[0]),
    hour: parseField(parts[1], FIELD_RANGES[1]),
    dom: parseField(parts[2], FIELD_RANGES[2]),
    month: parseField(parts[3], FIELD_RANGES[3]),
    dow: parseField(parts[4], FIELD_RANGES[4]),
  };
}

function matchesDate(p: ParsedCron, d: Date): boolean {
  return (
    p.minute.values.has(d.getMinutes()) &&
    p.hour.values.has(d.getHours()) &&
    // DOM and DOW share OR semantics in vixie cron: if both restricted, EITHER
    // matches; if one is `*`, only the other applies. We replicate that.
    matchesDomAndDow(p, d) &&
    p.month.values.has(d.getMonth() + 1)
  );
}

function isWildcard(f: FieldSpec): boolean {
  return f.values.size === f.max - f.min + 1;
}

function matchesDomAndDow(p: ParsedCron, d: Date): boolean {
  const domOk = p.dom.values.has(d.getDate());
  const dowOk = p.dow.values.has(d.getDay());
  const domWild = isWildcard(p.dom);
  const dowWild = isWildcard(p.dow);
  if (!domWild && !dowWild) return domOk || dowOk;
  if (domWild && !dowWild) return dowOk;
  if (!domWild && dowWild) return domOk;
  return true; // both wild
}

/**
 * Walk forward in 1-minute steps from `from` until we find the next minute
 * that matches the expression. Capped at ~2 years to bail on impossible
 * expressions (e.g. `0 0 31 2 *`).
 */
export function nextFire(p: ParsedCron, from: Date = new Date()): Date {
  // Align to the next whole minute and skip current to avoid re-firing.
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const limitMs = 2 * 365 * 24 * 60 * 60 * 1000;
  const limit = start.getTime() + limitMs;
  const cur = new Date(start.getTime());
  while (cur.getTime() < limit) {
    if (matchesDate(p, cur)) return new Date(cur.getTime());
    cur.setMinutes(cur.getMinutes() + 1);
  }
  throw new Error("cron expression yields no match within 2 years");
}

/** Convenience: parse + nextFire in one call. Validates the expression. */
export function nextFireFromExpr(expr: string, from: Date = new Date()): Date {
  return nextFire(parseCron(expr), from);
}
