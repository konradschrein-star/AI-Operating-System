/**
 * BullMQ queue depth, spoken over raw RESP on a socket.
 *
 * ── Why there is no redis client here ─────────────────────────────────────
 * forge-control has no redis dependency and is not getting one. `pnpm add`
 * under this runtime (NODE_ENV=production, which prunes devDependencies on the
 * next `--frozen-lockfile`) has bricked the executor before by removing `tsx`
 * and `typescript`. RESP2 is a text protocol; the six commands this file needs
 * fit in ~60 lines of `node:net`, and every byte of encode/parse is pure and
 * unit-tested. The socket is the only untested part.
 *
 * ── Why TYPE before LLEN/ZCARD ────────────────────────────────────────────
 * BullMQ's key layout is a convention, not a contract: `wait`/`active`/
 * `paused` are lists and `delayed`/`failed`/`completed` are zsets TODAY. Issue
 * `LLEN` against a zset and redis answers
 * `WRONGTYPE Operation against a key holding the wrong kind of value` — an
 * error you would be tempted to swallow as `0`. So we ask `TYPE` first and let
 * the answer choose the command. A key redis reports as `none` (or as any type
 * we cannot count) renders `depth: null` — ABSENT, never `0`.
 *
 * ── Why a real zero must be distinguishable from a dead probe (R67, N1) ───
 * S-C-content-forge-state.md §1 measured the live layout: 618 `bull:*` keys
 * across 47 queues, and `waiting=0`/`active=0` on every single one. So a
 * CORRECT probe returns zeroes today. That is exactly the shape a probe
 * pointed at a dead port would return if it caught its error and defaulted.
 * Hence the discriminated union: `{ok: true, …}` carries the zeroes and
 * `{ok: false, error}` carries the verbatim upstream message. There is no
 * third answer and no `?? 0` anywhere in this file.
 */

import net from "node:net";

/* ========================================================================== *
 * RESP2 — pure encode/decode
 * ========================================================================== */

/** A redis error reply. Boxed so it cannot be mistaken for a bulk string. */
export interface RespError {
  error: string;
}

export type RespValue = string | number | null | RespError | RespValue[];

export function isRespError(v: RespValue): v is RespError {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "error" in v;
}

/**
 * Encode a command as a RESP2 array of bulk strings — the inline-command
 * alternative cannot carry arbitrary bytes and silently mangles keys with
 * spaces, so it is not used.
 */
export function encodeCommand(args: readonly string[]): string {
  if (args.length === 0) throw new Error("encodeCommand: a command needs at least one argument");
  let out = `*${args.length}\r\n`;
  for (const a of args) out += `$${Buffer.byteLength(a, "utf8")}\r\n${a}\r\n`;
  return out;
}

export interface RespParseResult {
  value: RespValue;
  /** Bytes consumed from `offset`. */
  consumed: number;
}

/**
 * Parse ONE reply starting at `offset`.
 *
 * Returns `null` when the buffer does not yet hold a complete reply — replies
 * arrive split across TCP chunks and a parser that treated "short" as
 * "malformed" would fail intermittently under load and never in a test.
 * Genuinely malformed input throws with the offending byte.
 */
export function parseReply(buf: Buffer, offset = 0): RespParseResult | null {
  if (offset >= buf.length) return null;
  const crlf = buf.indexOf("\r\n", offset, "utf8");
  if (crlf === -1) return null;

  const marker = String.fromCharCode(buf[offset]!);
  const line = buf.toString("utf8", offset + 1, crlf);
  const headerLen = crlf + 2 - offset;

  switch (marker) {
    case "+":
      return { value: line, consumed: headerLen };
    case "-":
      return { value: { error: line }, consumed: headerLen };
    case ":": {
      const n = Number(line);
      if (!Number.isFinite(n)) {
        throw new Error(`parseReply: integer reply is not a number: ${JSON.stringify(line)}`);
      }
      return { value: n, consumed: headerLen };
    }
    case "$": {
      const len = Number(line);
      if (!Number.isInteger(len)) {
        throw new Error(`parseReply: bulk length is not an integer: ${JSON.stringify(line)}`);
      }
      if (len === -1) return { value: null, consumed: headerLen };
      const end = crlf + 2 + len;
      if (buf.length < end + 2) return null;
      return {
        value: buf.toString("utf8", crlf + 2, end),
        consumed: end + 2 - offset,
      };
    }
    case "*": {
      const count = Number(line);
      if (!Number.isInteger(count)) {
        throw new Error(`parseReply: array length is not an integer: ${JSON.stringify(line)}`);
      }
      if (count === -1) return { value: null, consumed: headerLen };
      const items: RespValue[] = [];
      let cursor = offset + headerLen;
      for (let i = 0; i < count; i++) {
        const item = parseReply(buf, cursor);
        if (item === null) return null;
        items.push(item.value);
        cursor += item.consumed;
      }
      return { value: items, consumed: cursor - offset };
    }
    default:
      throw new Error(
        `parseReply: unknown RESP type byte ${JSON.stringify(marker)} (0x${buf[offset]!.toString(16)}) at offset ${offset}`,
      );
  }
}

/* ========================================================================== *
 * Endpoint
 * ========================================================================== */

export interface RedisEndpoint {
  host: string;
  port: number;
  /** null when the URL carries no credentials. */
  password: string | null;
  /** Path-encoded database index, or null for the server default (0). */
  db: number | null;
}

export const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

/**
 * Parse a `redis://` URL. `rediss://` throws rather than silently connecting
 * in the clear — a probe that downgraded TLS without saying so would be a
 * worse defect than the one this file fixes.
 */
export function parseRedisUrl(raw: string): RedisEndpoint {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`parseRedisUrl: not a URL: ${JSON.stringify(raw)}`);
  }
  if (u.protocol === "rediss:") {
    throw new Error(
      `parseRedisUrl: rediss:// needs TLS, which this probe does not implement; got ${JSON.stringify(raw)}`,
    );
  }
  if (u.protocol !== "redis:") {
    throw new Error(
      `parseRedisUrl: expected a redis:// URL; got protocol ${JSON.stringify(u.protocol)}`,
    );
  }
  const port = u.port === "" ? 6379 : Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`parseRedisUrl: port out of range in ${JSON.stringify(raw)}`);
  }
  const dbPath = u.pathname.replace(/^\//, "");
  let db: number | null = null;
  if (dbPath !== "") {
    const n = Number(dbPath);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`parseRedisUrl: database index must be a non-negative integer; got ${JSON.stringify(dbPath)}`);
    }
    db = n;
  }
  return {
    host: u.hostname === "" ? "127.0.0.1" : u.hostname,
    port,
    password: u.password === "" ? null : decodeURIComponent(u.password),
    db,
  };
}

/* ========================================================================== *
 * BullMQ key layout
 * ========================================================================== */

export const BULL_SETS = ["wait", "active", "delayed", "failed", "completed", "paused"] as const;
export type BullSet = (typeof BULL_SETS)[number];

/**
 * The Content Forge MAINLINE queues — the ones a `content_jobs` row is routed
 * through — confirmed against
 * `/opt/content-forge/apps/worker-orchestrator/src/utils/dispatch-next.ts`
 * (the single place a status transition becomes a queue name; it returns
 * `queue-ai-generation`, `queue-qms-validation`, `queue-render-heavy`,
 * `queue-asset-collection`, `queue-clip-selection`, `queue-auto-label`) plus
 * `queue-ingest` (job entry, `processors/ingest.ts`) and `queue-video-stitch`
 * (`worker-video-stitch`). Names cross-checked against the canonical
 * `QUEUE_NAMES` in `/opt/content-forge/packages/queue/src/constants/queue-names.ts`.
 *
 * NOT all 47 queues under `bull:*`: the rest are other product lines
 * (`queue-drama-*`, `queue-reactor-*`, `queue-tutorial-*`, `queue-bundestag-*`)
 * whose depths say nothing about the five stuck content jobs.
 */
export const CONTENT_FORGE_QUEUES = [
  "queue-ingest",
  "queue-ai-generation",
  "queue-asset-collection",
  "queue-clip-selection",
  "queue-qms-validation",
  "queue-render-heavy",
  "queue-video-stitch",
  "queue-auto-label",
] as const;

export function bullKey(queue: string, set: string): string {
  return `bull:${queue}:${set}`;
}

export interface QueueSetDepth {
  set: string;
  key: string;
  /** Verbatim TYPE reply: `list`, `zset`, `none`, `hash`, … */
  redis_type: string;
  /**
   * Entry count, or null when the key holds no countable collection. null
   * means ABSENT — the surface must render it as such and never as 0.
   */
  depth: number | null;
}

export interface QueueDepth {
  queue: string;
  sets: QueueSetDepth[];
}

/** Which count command a redis TYPE answer permits, or null if none does. */
export function countCommandForType(redisType: string): "LLEN" | "ZCARD" | null {
  if (redisType === "list") return "LLEN";
  if (redisType === "zset") return "ZCARD";
  return null;
}

/**
 * Turn a (TYPE, count) reply pair into one set's depth.
 *
 * A redis ERROR from either reply THROWS — it aborts the whole probe into
 * `{ok: false}`. That is the point: an error is not a zero, and the only
 * honest thing to do with `WRONGTYPE` or `NOAUTH` is to surface it.
 */
export function resolveSetDepth(
  set: string,
  queue: string,
  typeReply: RespValue,
  countReply: RespValue | undefined,
): QueueSetDepth {
  const key = bullKey(queue, set);
  if (isRespError(typeReply)) {
    throw new Error(`TYPE ${key} failed: ${typeReply.error}`);
  }
  if (typeof typeReply !== "string") {
    throw new Error(
      `TYPE ${key} returned ${JSON.stringify(typeReply)}, which is not a type name`,
    );
  }
  const cmd = countCommandForType(typeReply);
  if (cmd === null) return { set, key, redis_type: typeReply, depth: null };

  if (countReply === undefined) {
    throw new Error(`${cmd} ${key} has no reply — the pipeline returned fewer replies than commands`);
  }
  if (isRespError(countReply)) {
    throw new Error(`${cmd} ${key} failed: ${countReply.error}`);
  }
  if (typeof countReply !== "number") {
    throw new Error(`${cmd} ${key} returned ${JSON.stringify(countReply)}, which is not an integer`);
  }
  return { set, key, redis_type: typeReply, depth: countReply };
}

/* ========================================================================== *
 * The probe (the only impure part of this file)
 * ========================================================================== */

export type QueueProbeResult =
  | {
      ok: true;
      as_of: string;
      endpoint: string;
      /** How many queues were asked about — a real zero has a nonzero count. */
      probed_queues: number;
      queues: QueueDepth[];
    }
  | {
      ok: false;
      as_of: string;
      endpoint: string;
      /** Verbatim upstream message. Never paraphrased, never defaulted away. */
      error: string;
    };

/** One RESP2 connection that can send a pipeline of commands and read back N replies. */
class RespConnection {
  private buf: Buffer = Buffer.alloc(0);
  private pending: RespValue[] = [];
  private want = 0;
  private settle: ((v: RespValue[]) => void) | null = null;
  private fail: ((e: Error) => void) | null = null;

  private constructor(private readonly sock: net.Socket) {
    sock.on("data", (chunk: Buffer) => this.onData(chunk));
    sock.on("error", (err: Error) => this.reject(err));
    sock.on("close", () => this.reject(new Error("redis closed the connection mid-probe")));
  }

  static connect(host: string, port: number, timeoutMs: number): Promise<RespConnection> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host, port });
      sock.setTimeout(timeoutMs);
      const onFail = (err: Error) => {
        sock.destroy();
        reject(err);
      };
      sock.once("error", onFail);
      sock.once("timeout", () =>
        onFail(new Error(`connect timed out after ${timeoutMs}ms to ${host}:${port}`)),
      );
      sock.once("connect", () => {
        sock.removeListener("error", onFail);
        sock.removeAllListeners("timeout");
        sock.setTimeout(timeoutMs);
        sock.on("timeout", () => sock.destroy(new Error(`redis probe timed out after ${timeoutMs}ms`)));
        resolve(new RespConnection(sock));
      });
    });
  }

  private reject(err: Error): void {
    const fail = this.fail;
    this.settle = null;
    this.fail = null;
    if (fail) fail(err);
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.drain();
  }

  /**
   * Parse everything complete in the buffer, then hand over if the current
   * `send()` has all its replies. Parsing is NOT gated on a pending `send()`:
   * redis may push the replies to a pipeline into the same TCP chunk as the
   * previous ones, and a parser that only ran while someone was waiting would
   * strand them in the buffer and hang the next call.
   */
  private drain(): void {
    try {
      for (;;) {
        const r = parseReply(this.buf, 0);
        if (r === null) break;
        this.buf = this.buf.subarray(r.consumed);
        this.pending.push(r.value);
      }
    } catch (err) {
      this.reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (this.settle !== null && this.pending.length >= this.want) {
      const settle = this.settle;
      const replies = this.pending.splice(0, this.want);
      this.settle = null;
      this.fail = null;
      settle(replies);
    }
  }

  send(commands: readonly (readonly string[])[]): Promise<RespValue[]> {
    if (commands.length === 0) return Promise.resolve([]);
    return new Promise<RespValue[]>((resolve, reject) => {
      this.want = commands.length;
      this.settle = resolve;
      this.fail = reject;
      this.sock.write(commands.map(encodeCommand).join(""), (err) => {
        if (err) this.reject(err);
      });
      this.drain();
    });
  }

  close(): void {
    this.settle = null;
    this.fail = null;
    this.sock.removeAllListeners("close");
    this.sock.destroy();
  }
}

export interface ProbeOptions {
  url?: string;
  queues?: readonly string[];
  sets?: readonly string[];
  timeoutMs?: number;
  /** Epoch ms for `as_of`. Passed in by callers that pin a clock. */
  now?: number;
}

/**
 * Ask redis for the depth of every `bull:<queue>:<set>` key of the named
 * queues. Two pipelined round trips: all TYPEs, then the counts the types
 * permit.
 *
 * Never throws. Every failure — bad URL, refused connection, timeout, redis
 * error reply, protocol garbage — comes back as `{ok: false, error}` with the
 * upstream message verbatim, because the caller is an HTTP handler that must
 * still answer with the rest of the pipeline data.
 */
export async function probeQueueDepths(opts: ProbeOptions = {}): Promise<QueueProbeResult> {
  const url = opts.url ?? process.env.REDIS_URL ?? DEFAULT_REDIS_URL;
  const queues = opts.queues ?? CONTENT_FORGE_QUEUES;
  const sets = opts.sets ?? BULL_SETS;
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const as_of = new Date(opts.now ?? Date.now()).toISOString();

  let endpoint = url;
  let conn: RespConnection | null = null;
  try {
    const ep = parseRedisUrl(url);
    endpoint = `${ep.host}:${ep.port}`;
    conn = await RespConnection.connect(ep.host, ep.port, timeoutMs);

    const handshake: string[][] = [];
    if (ep.password !== null) handshake.push(["AUTH", ep.password]);
    if (ep.db !== null) handshake.push(["SELECT", String(ep.db)]);
    if (handshake.length > 0) {
      const replies = await conn.send(handshake);
      replies.forEach((reply, i) => {
        if (isRespError(reply)) throw new Error(`${handshake[i]![0]} failed: ${reply.error}`);
      });
    }

    const pairs = queues.flatMap((queue) => sets.map((set) => ({ queue, set })));
    const typeReplies = await conn.send(pairs.map((p) => ["TYPE", bullKey(p.queue, p.set)]));

    const countable: { index: number; cmd: string; key: string }[] = [];
    pairs.forEach((p, i) => {
      const reply = typeReplies[i];
      if (typeof reply !== "string") return; // resolveSetDepth reports it below
      const cmd = countCommandForType(reply);
      if (cmd !== null) countable.push({ index: i, cmd, key: bullKey(p.queue, p.set) });
    });
    const countReplies = await conn.send(countable.map((c) => [c.cmd, c.key]));
    const countByIndex = new Map<number, RespValue>();
    countable.forEach((c, i) => countByIndex.set(c.index, countReplies[i]));

    const byQueue = new Map<string, QueueSetDepth[]>();
    pairs.forEach((p, i) => {
      const depth = resolveSetDepth(p.set, p.queue, typeReplies[i], countByIndex.get(i));
      const arr = byQueue.get(p.queue);
      if (arr === undefined) byQueue.set(p.queue, [depth]);
      else arr.push(depth);
    });

    return {
      ok: true,
      as_of,
      endpoint,
      probed_queues: queues.length,
      queues: queues.map((queue) => ({ queue, sets: byQueue.get(queue) ?? [] })),
    };
  } catch (err) {
    return {
      ok: false,
      as_of,
      endpoint,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    conn?.close();
  }
}
