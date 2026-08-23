/**
 * nginx-parser.ts — read the ingress layer of this box as data.
 *
 * 19 vhosts live in /etc/nginx/sites-enabled and nothing in the AI OS could
 * see them: MAP's fourth column ("which domain reaches which service") had no
 * producer at all. This module is that producer.
 *
 * It is a real (small) nginx config parser, not a pile of regexes: the config
 * language is `directive args… ;` plus `directive args… { … }`, with `#`
 * comments and single/double quoted arguments. A regex over `server_name`
 * cannot tell an outer `server {}` from a nested `location {}`, and the
 * difference decides which `proxy_pass` belongs to which domain — so we
 * tokenize once and walk the tree.
 *
 * Two hard rules, both learned from this repo's own postmortems:
 *  - Nothing here throws for a caller. A vhost whose certificate cannot be
 *    read reports `ssl_error`, a file that cannot be read is reported in
 *    `errors[]`, and the remaining vhosts still parse. A dark ingress column
 *    is worse than a partial one, but a WRONG one is worse than both — hence
 *    every failure is named rather than swallowed into an empty list.
 *  - `include` is NOT followed. Nothing in sites-enabled uses it today
 *    (verified 2026-08-23); if one ever does, its directives are reported in
 *    `unresolved_includes` rather than silently missing.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { X509Certificate } from "node:crypto";

export const NGINX_SITES_DIR =
  process.env.NGINX_SITES_DIR ?? "/etc/nginx/sites-enabled";

/** One directive in the config tree. `block` is null for `foo bar;`. */
export interface NginxDirective {
  name: string;
  args: string[];
  block: NginxDirective[] | null;
}

export interface NginxListen {
  /** Port as written (`listen 443 ssl;` → 443). Null when unparseable
   *  (e.g. a unix: socket), which is reported rather than guessed. */
  port: number | null;
  ssl: boolean;
  raw: string;
}

export interface NginxVhost {
  /** Absolute path of the file this server block came from. */
  file: string;
  /** Every name in `server_name`, in file order. `_` (catch-all) included. */
  server_names: string[];
  listens: NginxListen[];
  /** Every distinct `proxy_pass` target inside this server block, including
   *  the ones nested in `location` blocks — that is where they all live. */
  upstreams: string[];
  /** `root` / `alias` targets, for statically served vhosts. */
  roots: string[];
  ssl_certificate: string | null;
  /** ISO 8601 `notAfter` of the certificate, when it could be read. */
  ssl_expires_at: string | null;
  /** Whole days from `now` to expiry. Negative when already expired. */
  ssl_days_left: number | null;
  /** Why the certificate could not be read/parsed. Null when fine or absent. */
  ssl_error: string | null;
  /** `include` directives found inside this server block, unfollowed. */
  unresolved_includes: string[];
}

export interface NginxScan {
  dir: string;
  /** Config files read, absolute, sorted. */
  files: string[];
  vhosts: NginxVhost[];
  /** Per-file read/parse failures. A file here contributed no vhosts. */
  errors: { file: string; error: string }[];
}

/* ── Lexer ───────────────────────────────────────────────────────────────── */

const TERMINATORS = new Set([";", "{", "}"]);

/**
 * Split a config into words and the three structural tokens (`;`, `{`, `}`).
 * Comments run to end of line, quotes protect everything inside them
 * (including `#`, `;` and braces). Pure, never throws.
 */
export function tokenizeNginx(text: string): string[] {
  const tokens: string[] = [];
  let word = "";
  const flush = (): void => {
    if (word.length > 0) {
      tokens.push(word);
      word = "";
    }
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "#") {
      flush();
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let quoted = "";
      while (i < text.length && text[i] !== quote) {
        // nginx honours a backslash escape inside quotes.
        if (text[i] === "\\" && i + 1 < text.length) {
          quoted += text[i + 1];
          i += 2;
          continue;
        }
        quoted += text[i];
        i++;
      }
      word += quoted;
      continue;
    }
    if (TERMINATORS.has(ch)) {
      flush();
      tokens.push(ch);
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    word += ch;
  }
  flush();
  return tokens;
}

/**
 * Build the directive tree. Unbalanced braces are tolerated the way nginx -t
 * would not: an unclosed block simply ends at EOF, and a stray `}` closes
 * nothing. A malformed file must degrade to fewer vhosts, never to an
 * exception in the middle of the map endpoint.
 */
export function parseNginxConfig(text: string): NginxDirective[] {
  const tokens = tokenizeNginx(text);
  let i = 0;

  const parseBlock = (depth: number): NginxDirective[] => {
    const out: NginxDirective[] = [];
    let words: string[] = [];
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === ";") {
        i++;
        if (words.length > 0) {
          out.push({ name: words[0], args: words.slice(1), block: null });
          words = [];
        }
        continue;
      }
      if (t === "{") {
        i++;
        const inner = parseBlock(depth + 1);
        if (words.length > 0) {
          out.push({ name: words[0], args: words.slice(1), block: inner });
          words = [];
        }
        continue;
      }
      if (t === "}") {
        i++;
        if (depth === 0) continue; // stray close — ignore, keep parsing
        return out;
      }
      words.push(t);
      i++;
    }
    return out;
  };

  return parseBlock(0);
}

/** Depth-first walk over a directive tree, root(s) first. */
function* walk(directives: NginxDirective[]): Generator<NginxDirective> {
  for (const d of directives) {
    yield d;
    if (d.block) yield* walk(d.block);
  }
}

/** Same walk, but never descends into a nested `server { … }` — those are
 *  separate vhosts and their `proxy_pass` must not be attributed to the
 *  enclosing one. */
function* walkOwnDirectives(directives: NginxDirective[]): Generator<NginxDirective> {
  for (const d of directives) {
    if (d.name === "server" && d.block) continue;
    yield d;
    if (d.block) yield* walkOwnDirectives(d.block);
  }
}

function parseListen(args: string[]): NginxListen {
  const raw = args.join(" ");
  const ssl = args.some((a) => a === "ssl") || /\bssl\b/.test(raw);
  // `443`, `443 ssl`, `127.0.0.1:8080`, `[::]:443 ssl`, `unix:/path`
  const first = args[0] ?? "";
  let port: number | null = null;
  if (/^\d+$/.test(first)) {
    port = Number(first);
  } else {
    const m = /:(\d+)$/.exec(first);
    if (m) port = Number(m[1]);
  }
  return { port, ssl, raw };
}

/* ── Vhost extraction ────────────────────────────────────────────────────── */

/**
 * Extract every `server { … }` block in one config file. Pure — the caller
 * supplies the text, so this is directly testable without touching /etc.
 * Certificate expiry is NOT read here (that is I/O); see readNginxVhosts.
 */
export function vhostsFromConfig(text: string, file: string): NginxVhost[] {
  const tree = parseNginxConfig(text);
  const vhosts: NginxVhost[] = [];
  for (const top of walk(tree)) {
    if (top.name !== "server" || !top.block) continue;
    const serverNames: string[] = [];
    const listens: NginxListen[] = [];
    const upstreams: string[] = [];
    const roots: string[] = [];
    const includes: string[] = [];
    let cert: string | null = null;

    // walkOwnDirectives, not walk: a nested `server {}` is its own vhost and
    // is reached by the outer walk anyway — folding its directives into this
    // one would attribute another domain's proxy_pass here.
    for (const d of walkOwnDirectives(top.block)) {
      switch (d.name) {
        case "server_name":
          for (const a of d.args) if (!serverNames.includes(a)) serverNames.push(a);
          break;
        case "listen":
          listens.push(parseListen(d.args));
          break;
        case "proxy_pass":
          if (d.args[0] && !upstreams.includes(d.args[0])) upstreams.push(d.args[0]);
          break;
        case "root":
        case "alias":
          if (d.args[0] && !roots.includes(d.args[0])) roots.push(d.args[0]);
          break;
        case "ssl_certificate":
          if (d.args[0]) cert = d.args[0];
          break;
        case "include":
          if (d.args[0] && !includes.includes(d.args[0])) includes.push(d.args[0]);
          break;
        default:
          break;
      }
    }

    vhosts.push({
      file,
      server_names: serverNames,
      listens,
      upstreams,
      roots,
      ssl_certificate: cert,
      ssl_expires_at: null,
      ssl_days_left: null,
      ssl_error: null,
      unresolved_includes: includes,
    });
  }
  return vhosts;
}

/**
 * Read a PEM certificate's `notAfter`. Returns the failure as a string
 * instead of throwing — an unreadable cert must degrade one field of one row,
 * not the endpoint.
 */
export async function readCertificateExpiry(
  certPath: string,
  now: Date = new Date(),
): Promise<{ expires_at: string | null; days_left: number | null; error: string | null }> {
  let pem: Buffer;
  try {
    pem = await fs.readFile(certPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { expires_at: null, days_left: null, error: `cannot read certificate: ${msg}` };
  }
  let validTo: string;
  try {
    validTo = new X509Certificate(pem).validTo;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { expires_at: null, days_left: null, error: `cannot parse certificate: ${msg}` };
  }
  const when = new Date(validTo);
  if (Number.isNaN(when.getTime())) {
    return {
      expires_at: null,
      days_left: null,
      error: `certificate notAfter is unparseable: ${validTo}`,
    };
  }
  const days = Math.floor((when.getTime() - now.getTime()) / 86_400_000);
  return { expires_at: when.toISOString(), days_left: days, error: null };
}

/**
 * Parse every enabled vhost on this box. sites-enabled holds symlinks into
 * sites-available; `fs.readFile` follows them, and `stat` (not `lstat`)
 * decides file-ness, so the symlink layout is transparent here.
 */
export async function readNginxVhosts(
  dir: string = NGINX_SITES_DIR,
): Promise<NginxScan> {
  const scan: NginxScan = { dir, files: [], vhosts: [], errors: [] };
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read nginx site directory ${dir}: ${msg}`);
  }
  names.sort();
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const abs = path.join(dir, name);
    let text: string;
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) continue;
      text = await fs.readFile(abs, "utf8");
    } catch (err) {
      scan.errors.push({
        file: abs,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    scan.files.push(abs);
    let parsed: NginxVhost[];
    try {
      parsed = vhostsFromConfig(text, abs);
    } catch (err) {
      scan.errors.push({
        file: abs,
        error: `parse failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    for (const v of parsed) {
      if (v.ssl_certificate) {
        const exp = await readCertificateExpiry(v.ssl_certificate);
        v.ssl_expires_at = exp.expires_at;
        v.ssl_days_left = exp.days_left;
        v.ssl_error = exp.error;
      }
      scan.vhosts.push(v);
    }
  }
  return scan;
}
