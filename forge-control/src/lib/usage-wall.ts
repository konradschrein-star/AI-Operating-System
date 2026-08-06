/**
 * Subscription usage-wall survival — the pure logic behind auto-recovery.
 *
 * Context (incident 2026-08-05, ~10:00–15:00 Europe/Berlin): the Claude
 * subscription's 5-hour usage window hit 100%. Every `claude` child in flight
 * died with exit 1, the executor wrote each one up as a plain failure, and
 * project-tick's reconcile did what it does for a failure: marked the task
 * `failed` and flipped the project to `blocked`. Both active projects went
 * down inside eighty seconds of each other and the whole fleet sat dead for
 * five hours until Konrad came back and called /unwedge by hand.
 *
 * Nothing was actually broken. The runs bounced off a wall that clears itself
 * on a published schedule — and the schedule is IN THE ERROR TEXT:
 *
 *   Executor failed: claude-code exit 1: You've hit your session limit ·
 *   resets 1:10pm (Europe/Berlin)
 *
 * (Verified against the live `runs` table: 41 rows carry the `session limit`
 * wording, 56 the `weekly limit` wording, two of them from the incident
 * window itself — a stable signature, not a one-off string.)
 *
 * So the engine should read the sign rather than call for a human. This module
 * answers three questions, all of them pure:
 *
 *   1. Is this failure a usage wall, or a real one?   classifyUsageWall()
 *   2. When does the wall lift?                       parseResetAt()
 *   3. When do we try again, and when do we stop?     planUsageWallRetry()
 *
 * plus the one-push-per-outage rule (shouldAnnounceOutage). The I/O — re-queuing
 * the run with `runs.wake_after` (migration 0036), reading the last error entry
 * out of the thread, queueing the notification — lives in db/runs.ts,
 * db/projects.ts and lib/project-tick.ts. Nothing here touches a database, a
 * clock or a network: `nowMs` is always an argument.
 */

/* ------------------------------------------------------------------------- *
 * 1. Classification
 * ------------------------------------------------------------------------- */

/**
 * Which wall was hit. It changes nothing in the retry maths — the reset time
 * does all the work — but it is carried through into the log line and Konrad's
 * push, because "session" means hours and "weekly" means possibly days, and a
 * message that does not distinguish them is a message he has to go and check.
 */
export type UsageWallKind = "session" | "weekly" | "unspecified";

export interface UsageWallSignature {
  kind: UsageWallKind;
  /** The reset clause verbatim, e.g. `"1:10pm (Europe/Berlin)"` — everything
   *  after "resets", untouched, so parseResetAt() and the human-facing message
   *  read the same string. `null` when the message names no reset time. */
  resetHint: string | null;
}

/**
 * The subscription-wall wording, and ONLY that.
 *
 * Deliberately narrow. A false positive here is the expensive direction: it
 * would park a genuinely broken task on a timer instead of failing it, so a
 * real bug would go unreported for hours and then be retried into the same
 * crash. A false negative merely reproduces today's behaviour (block, notify,
 * wait for Konrad), which is survivable.
 *
 * Three alternatives are matched because the CLI's phrasing has moved between
 * versions and a wording change must not silently switch auto-recovery off:
 *  - "You've hit your session limit" / "weekly limit" — what the live rows say.
 *  - "Claude usage limit reached" — the older CLI wording.
 *  - "5-hour limit" / "five hour limit" — the window named directly.
 *
 * NOT matched, on purpose: bare "rate limit", "429", "too many requests". Those
 * are the API's per-minute throttle, they clear in seconds, and
 * account-health.ts already classifies them (`ErrorClass = "rate_limit"`).
 * Parking a task for fifteen minutes over a two-second throttle would be a
 * self-inflicted outage.
 */
// `['’]?` on every one: the CLI renders the apostrophe as U+2019 in some
// terminals and U+0027 in others, and the two are different characters. A
// regex that knows only the straight quote switches auto-recovery off silently
// the day a dependency changes how it prints.
const SESSION_WALL_RE = /you['’]?\s?ve hit your session limit|\b(?:5|five)[- ]?hour limit\b/i;
const WEEKLY_WALL_RE = /you['’]?\s?ve hit your weekly limit|\bweekly limit reached\b/i;
const GENERIC_WALL_RE =
  /you['’]?\s?ve hit your (?:usage|opus|sonnet|haiku) limit|claude (?:ai )?usage limit reached/i;

/** Everything after the final "resets"/"reset at", trimmed. Anchored to the end
 *  of the line rather than to a closing paren so a message that names a zone
 *  ("1:10pm (Europe/Berlin)") and one that does not ("1:10pm") both survive —
 *  parseResetAt() is the one that decides whether the hint is usable. */
const RESET_HINT_RE = /\breset(?:s|ting)?(?:\s+at)?\s+([^\n]+?)\s*$/i;

export function classifyUsageWall(
  text: string | null | undefined,
): UsageWallSignature | null {
  if (!text) return null;

  const kind: UsageWallKind | null = SESSION_WALL_RE.test(text)
    ? "session"
    : WEEKLY_WALL_RE.test(text)
      ? "weekly"
      : GENERIC_WALL_RE.test(text)
        ? "unspecified"
        : null;
  if (kind === null) return null;

  // Read the hint off the LAST line: the executor prefixes the child's stderr
  // ("Executor failed: claude-code exit 1: ..."), and a multi-line stderr would
  // otherwise let an earlier line's stray "reset" win.
  const lastLine = text.trimEnd().split("\n").pop() ?? "";
  const hint = RESET_HINT_RE.exec(lastLine)?.[1]?.trim();
  return { kind, resetHint: hint && hint.length > 0 ? hint : null };
}

/* ------------------------------------------------------------------------- *
 * 2. Reset-time parsing
 * ------------------------------------------------------------------------- */

/**
 * Why this exists at all, rather than a bare backoff ladder: the incident's
 * runs died at 09:14 UTC (11:14 Berlin) against a wall that lifted at 13:10
 * Berlin — one hour fifty-six minutes later. A 15/30/60-minute ladder spends
 * its last retry at 10:59 UTC and hard-fails ELEVEN MINUTES before the wall
 * clears, which is the same outage we are fixing with two extra hours of
 * pointless retrying in front of it. The margin is thin on purpose in the test
 * (U4 asserts it), because it is exactly the kind of near-miss that reads as
 * "close enough" until it isn't. The reset time is the only thing in the error
 * that actually knows when to come back, so it has to be read.
 */

/** Two minutes of slack on top of the published reset. The wall does not clear
 *  to the second, our clock is not Anthropic's clock, and waking one minute
 *  early costs a whole retry. */
export const USAGE_WALL_RESET_GRACE_MS = 2 * 60_000;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** IANA zone as the CLI writes it: `(Europe/Berlin)`. */
const TZ_RE = /\(([A-Za-z]+(?:\/[A-Za-z_+\-0-9]+)+)\)/;
/** `2pm`, `1:10pm`, `13:10` — am/pm optional so a 24h rendering still parses. */
const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
/** `Jul 7` / `Jul 7,` — only present on the weekly wall. */
const DATE_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i;

/**
 * Offset of `tz` from UTC at a given instant, in ms, or null if Intl does not
 * know the zone. Derived by formatting the instant in the zone and reading the
 * wall-clock fields back — the only way to get a zone offset out of the
 * platform without a date library, and correct across DST because the offset is
 * sampled AT the instant in question.
 */
function tzOffsetMs(epochMs: number, tz: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(epochMs));
    const field = (type: string): number => {
      const raw = parts.find((p) => p.type === type)?.value;
      const n = raw === undefined ? NaN : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`missing ${type}`);
      return n;
    };
    // `hour12: false` renders midnight as 24 in some ICU versions; % 24 folds
    // it back without disturbing any other hour.
    const asUtc = Date.UTC(
      field("year"),
      field("month") - 1,
      field("day"),
      field("hour") % 24,
      field("minute"),
      field("second"),
    );
    return asUtc - epochMs;
  } catch {
    // An unknown zone throws RangeError. Not an error condition: the caller
    // falls back to the ladder, which is exactly what it is for.
    return null;
  }
}

/** Wall-clock fields in `tz` → epoch ms. Two passes because the offset depends
 *  on the instant we are still solving for; the second pass corrects the ~2×
 *  per year case where the naive guess lands on the far side of a DST switch. */
function zonedToEpoch(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  tz: string,
): number | null {
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  const first = tzOffsetMs(naive, tz);
  if (first === null) return null;
  const guess = naive - first;
  const second = tzOffsetMs(guess, tz);
  if (second === null) return null;
  return second === first ? guess : naive - second;
}

/** Today's calendar date in `tz`, as of `epochMs`. */
function zonedDate(
  epochMs: number,
  tz: string,
): { y: number; m: number; d: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(epochMs));
    const field = (type: string): number => {
      const raw = parts.find((p) => p.type === type)?.value;
      const n = raw === undefined ? NaN : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`missing ${type}`);
      return n;
    };
    return { y: field("year"), m: field("month"), d: field("day") };
  } catch {
    return null;
  }
}

/**
 * `"1:10pm (Europe/Berlin)"` → the epoch ms at which the wall lifts, or `null`
 * when the hint cannot be resolved with certainty.
 *
 * `null` is a first-class, expected answer — a hint with no zone, an unknown
 * zone, or no time at all all produce it, and the caller falls back to the
 * fixed ladder. GUESSING a zone would be worse than not parsing: assuming UTC
 * for a Europe/Berlin string wakes the fleet two hours early in summer, burns a
 * retry on a wall that is still up, and does it silently.
 *
 * Two shapes are handled, both taken from live rows:
 *  - time only — `"1:10pm (Europe/Berlin)"`, the session wall. The date is
 *    today in that zone, rolled forward a day if the time has already passed
 *    (a wall hit at 23:50 that resets at 00:10 resets tomorrow).
 *  - date + time — `"Jul 7, 2pm (Europe/Berlin)"`, the weekly wall. The year is
 *    this year in that zone, rolled forward one if that lands well in the past,
 *    which is the December→January case.
 */
export function parseResetAt(
  hint: string | null | undefined,
  nowMs: number,
): number | null {
  if (!hint) return null;
  const tz = TZ_RE.exec(hint)?.[1];
  if (!tz) return null;

  // Strip the zone before reading anything else, or a name like "Etc/GMT+2"
  // would feed its digits to TIME_RE.
  const body = hint.replace(TZ_RE, " ");

  // The DATE must come out BEFORE the time, and its text must be removed from
  // what the time is read from. "Jul 7, 2pm" otherwise hands TIME_RE the day —
  // it matches the leading `7` with no meridiem and resolves to 07:00, seven
  // hours before the wall actually lifts, which is a wasted retry that looks
  // exactly like a successful parse.
  const dated = DATE_RE.exec(body);
  const timeBody = dated ? body.replace(dated[0], " ") : body;

  const time = TIME_RE.exec(timeBody);
  if (!time) return null;
  const rawHour = Number(time[1]);
  const minute = time[2] === undefined ? 0 : Number(time[2]);
  const meridiem = time[3]?.toLowerCase();
  if (!Number.isFinite(rawHour) || !Number.isFinite(minute)) return null;
  if (minute > 59) return null;
  // A bare integer is not a time. Every rendering the CLI actually emits
  // carries a meridiem ("2pm") or a colon ("13:10"); a lone number is far more
  // likely to be a day, a count or a version than an hour, and reading it as
  // one would park the fleet on a confidently wrong clock. Refuse, and let the
  // ladder handle it.
  if (!meridiem && time[2] === undefined) return null;

  let hour: number;
  if (meridiem === "am") {
    if (rawHour < 1 || rawHour > 12) return null;
    hour = rawHour === 12 ? 0 : rawHour;
  } else if (meridiem === "pm") {
    if (rawHour < 1 || rawHour > 12) return null;
    hour = rawHour === 12 ? 12 : rawHour + 12;
  } else {
    // No meridiem — must be a 24h rendering, and an out-of-range number means
    // we misread the string rather than that we should clamp it.
    if (rawHour > 23) return null;
    hour = rawHour;
  }

  const today = zonedDate(nowMs, tz);
  if (!today) return null;

  if (dated) {
    const month = MONTHS[dated[1]!.toLowerCase()]!;
    const day = Number(dated[2]);
    if (day < 1 || day > 31) return null;
    const thisYear = zonedToEpoch(today.y, month, day, hour, minute, tz);
    if (thisYear === null) return null;
    // A weekly wall never resets more than ~7 days back; anything further in
    // the past is last year's date read in this year, i.e. the year wrapped.
    if (thisYear >= nowMs - 8 * 86_400_000) return thisYear;
    return zonedToEpoch(today.y + 1, month, day, hour, minute, tz);
  }

  const sameDay = zonedToEpoch(today.y, today.m, today.d, hour, minute, tz);
  if (sameDay === null) return null;
  if (sameDay > nowMs) return sameDay;
  // Date.UTC normalises day 32 into the next month, so no calendar maths here.
  return zonedToEpoch(today.y, today.m, today.d + 1, hour, minute, tz);
}

/* ------------------------------------------------------------------------- *
 * 3. Retry planning
 * ------------------------------------------------------------------------- */

/**
 * The fallback ladder, used when the message carries no usable reset time.
 * Fifteen, thirty, sixty minutes: long enough not to hammer a wall that clears
 * on the hour, short enough that a wall lifting early is noticed within the
 * quarter hour.
 */
export const USAGE_WALL_BACKOFF_MS: readonly number[] = [
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
];

/**
 * How many times ONE run may be parked before the engine gives up and takes the
 * old path (task failed, project blocked, Konrad told).
 *
 * This is a cap of its own rather than `MAX_TASK_ATTEMPTS` (db/projects.ts),
 * and the distinction is deliberate: `attempt` counts times the TASK was
 * retried because its work failed, and it is the budget an operator spends with
 * /retry and /unwedge. A usage wall is not the task's fault — it never started.
 * Charging the outage to that budget would mean a night of two walls left the
 * task with no operator retries for a real failure the next morning. The two
 * counters are kept apart on purpose; `attempt` is untouched by this path.
 */
export const USAGE_WALL_MAX_RETRIES = 3;

/** Ceiling on a single park. A weekly wall can name a reset days out; sleeping
 *  on it verbatim would leave the fleet apparently dead with nothing to look
 *  at. Six hours comfortably covers the 5-hour window (the case this exists
 *  for) and turns a multi-day wall into a small number of visible re-checks
 *  instead of one enormous invisible one. */
export const USAGE_WALL_MAX_DEFER_MS = 6 * 60 * 60_000;

/** Floor. A reset time already in the past (clock skew, a wall that lifted
 *  while we were reconciling) must still cost a minute — an immediate re-queue
 *  is the livelock migration 0036 was written to end. */
export const USAGE_WALL_MIN_DEFER_MS = 60_000;

export type UsageWallRetryPlan =
  | {
      action: "defer";
      /** 1-based: the attempt this plan represents. Persisted on the run as
       *  `metadata.usage_wall_attempts` and fed back in as `priorAttempts`. */
      attempt: number;
      delayMs: number;
      wakeAtMs: number;
      /** Which input decided the delay — the log line has to say, because
       *  "parked for 3h58m" and "parked for 15m" have very different causes. */
      basis: "reset_time" | "backoff_ladder";
    }
  | { action: "give_up"; attempt: number; reason: string };

export function planUsageWallRetry(input: {
  /** `metadata.usage_wall_attempts` of the run that just died; 0 first time. */
  priorAttempts: number;
  nowMs: number;
  /** From parseResetAt(); null when the message named no usable reset. */
  resetAtMs: number | null;
  maxRetries?: number;
  ladderMs?: readonly number[];
  maxDeferMs?: number;
  minDeferMs?: number;
  graceMs?: number;
}): UsageWallRetryPlan {
  const maxRetries = input.maxRetries ?? USAGE_WALL_MAX_RETRIES;
  const ladder = input.ladderMs ?? USAGE_WALL_BACKOFF_MS;
  const maxDefer = input.maxDeferMs ?? USAGE_WALL_MAX_DEFER_MS;
  const minDefer = input.minDeferMs ?? USAGE_WALL_MIN_DEFER_MS;
  const grace = input.graceMs ?? USAGE_WALL_RESET_GRACE_MS;

  // A corrupt or absent counter reads as "no retries spent yet". Treating a NaN
  // as exhausted would refuse to recover from the very outage this is for;
  // treating it as 0 costs at most one extra park.
  const prior =
    Number.isFinite(input.priorAttempts) && input.priorAttempts > 0
      ? Math.floor(input.priorAttempts)
      : 0;

  if (prior >= maxRetries) {
    return {
      action: "give_up",
      attempt: prior,
      reason: `${prior} usage-wall retries already spent (cap ${maxRetries}) — the wall is not lifting on its own`,
    };
  }
  if (ladder.length === 0) {
    return {
      action: "give_up",
      attempt: prior,
      reason: "no backoff ladder configured",
    };
  }

  const attempt = prior + 1;
  // Past the end of the ladder, the last rung repeats — reachable whenever
  // maxRetries is raised above the ladder's length.
  const rung = ladder[Math.min(prior, ladder.length - 1)]!;

  let delayMs = rung;
  let basis: "reset_time" | "backoff_ladder" = "backoff_ladder";
  if (input.resetAtMs !== null) {
    const untilReset = input.resetAtMs + grace - input.nowMs;
    // The reset only wins when it is LATER than the ladder rung. A wall that
    // claims to lift in 30 seconds still gets the full rung: the published time
    // is when the window rolls, not when capacity is actually free.
    if (untilReset > delayMs) {
      delayMs = untilReset;
      basis = "reset_time";
    }
  }

  delayMs = Math.min(Math.max(delayMs, minDefer), maxDefer);
  return { action: "defer", attempt, delayMs, wakeAtMs: input.nowMs + delayMs, basis };
}

/* ------------------------------------------------------------------------- *
 * 4. One push per outage
 * ------------------------------------------------------------------------- */

/** The `notifications.source` this lane writes under. Its own value so the
 *  dedup query can find the last outage push without matching the ordinary
 *  "project" traffic. */
export const USAGE_WALL_NOTIFICATION_SOURCE = "usage_wall";

/**
 * How close together two usage-wall pushes may be.
 *
 * Konrad's rule for this round is "ONE notification per outage, not per task",
 * and the failure it names is real: on 2026-08-05 eleven tasks across two
 * projects hit the wall inside ninety seconds and each would have produced its
 * own 🚫. There is no outage ID to key on — the wall is inferred from run
 * corpses, not reported — so the dedup is a time window, and it is set to the
 * longest a single park can last (USAGE_WALL_MAX_DEFER_MS). Every task felled
 * by one wall is therefore collapsed into the first task's message, while a
 * genuinely new outage six hours later is still announced.
 */
export const OUTAGE_ANNOUNCE_WINDOW_MS = USAGE_WALL_MAX_DEFER_MS;

/** `lastAnnouncedAtMs === null` means "nothing on record, or we could not read
 *  the record" — and both answer yes. A duplicate push is a mild annoyance; a
 *  swallowed one recreates the silence that made the incident five hours long
 *  instead of five minutes. */
export function shouldAnnounceOutage(
  lastAnnouncedAtMs: number | null,
  nowMs: number,
  windowMs: number = OUTAGE_ANNOUNCE_WINDOW_MS,
): boolean {
  if (lastAnnouncedAtMs === null || !Number.isFinite(lastAnnouncedAtMs)) return true;
  // A timestamp in the future is a clock that moved backwards, not a push we
  // just sent — but suppressing on it would be the silent direction, so the
  // comparison is one-sided on purpose.
  return nowMs - lastAnnouncedAtMs >= windowMs;
}

/** Round a ms duration to the coarsest unit that still reads precisely — used
 *  in both the log line and Konrad's push, so they always agree. */
export function formatDelay(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}m`;
}

/**
 * The single message Konrad gets per outage. Assembled here, next to the rule
 * that fires it, so the wording and the dedup window can never drift apart.
 *
 * It says three things and stops: what happened, that nothing needs doing, and
 * when the fleet comes back. `wakeAtIso` is rendered by the caller in Konrad's
 * zone — this module has no business knowing what that is.
 */
export function outageMessage(input: {
  kind: UsageWallKind;
  resetHint: string | null;
  delayMs: number;
  wakeAtLabel: string;
}): string {
  const wall =
    input.kind === "session"
      ? "5-hour session limit"
      : input.kind === "weekly"
        ? "weekly limit"
        : "usage limit";
  const resets = input.resetHint ? ` (resets ${input.resetHint})` : "";
  return (
    `⏸️ Claude ${wall} hit${resets}. The fleet paused itself — the tasks that bounced off ` +
    `the wall are parked, not failed, and no project was blocked. First retry in ` +
    `${formatDelay(input.delayMs)}, at ${input.wakeAtLabel}. Nothing for you to do; ` +
    `it will auto-resume.`
  );
}
