/**
 * Tests for nginx-parser.ts — the ingress producer behind MAP's domain column.
 *
 * Run: pnpm test   (`tsx --test src/lib/*.test.ts`)
 *
 * The load-bearing assertions are the ones a regex-based "parser" would fail:
 *  - a `proxy_pass` inside a `location` belongs to the enclosing server, and a
 *    SECOND server block in the same file must not inherit it;
 *  - `#` inside a quoted argument is not a comment, and a commented-out
 *    `server_name` is not a domain;
 *  - a malformed file degrades to fewer vhosts, never to a thrown exception
 *    inside the /api/map request.
 * Each of those is a way the domain column could have shown a WRONG mapping,
 * which is worse than the empty column it replaced.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  tokenizeNginx,
  parseNginxConfig,
  vhostsFromConfig,
  readCertificateExpiry,
  readNginxVhosts,
} from "./nginx-parser.ts";

const HUB = `
# The Content Forge hub — real shape, trimmed.
server {
    server_name hub.schreinercontentsystems.com;

    location /_next/static/ {
        alias /opt/content-forge/apps/hub-web/.next/static/;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }

    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/hub.schreinercontentsystems.com/fullchain.pem;
}

server {
    listen 80;
    server_name hub.schreinercontentsystems.com;
    return 301 https://$host$request_uri;
}
`;

describe("tokenizeNginx", () => {
  test("comments are dropped, quoted arguments are kept whole", () => {
    const tokens = tokenizeNginx(
      'add_header Cache-Control "public, max-age=31536000"; # trailing note\nlisten 443 ssl;',
    );
    assert.deepEqual(tokens, [
      "add_header",
      "Cache-Control",
      "public, max-age=31536000",
      ";",
      "listen",
      "443",
      "ssl",
      ";",
    ]);
  });

  test("a # inside quotes is data, not a comment", () => {
    const tokens = tokenizeNginx('add_header X-Colour "#ff0000";');
    assert.deepEqual(tokens, ["add_header", "X-Colour", "#ff0000", ";"]);
  });
});

describe("parseNginxConfig", () => {
  test("nesting is preserved", () => {
    const tree = parseNginxConfig("server { location / { proxy_pass http://x; } }");
    assert.equal(tree.length, 1);
    assert.equal(tree[0].name, "server");
    const loc = tree[0].block?.[0];
    assert.equal(loc?.name, "location");
    assert.deepEqual(loc?.args, ["/"]);
    assert.equal(loc?.block?.[0].name, "proxy_pass");
  });

  test("an unterminated block ends at EOF instead of throwing", () => {
    assert.doesNotThrow(() => parseNginxConfig("server { listen 80;"));
    const tree = parseNginxConfig("server { listen 80;");
    assert.equal(tree[0].name, "server");
    assert.equal(tree[0].block?.[0].name, "listen");
  });

  test("garbage never throws", () => {
    assert.doesNotThrow(() => parseNginxConfig("}}} ; ; { {"));
    assert.doesNotThrow(() => parseNginxConfig(""));
  });
});

describe("vhostsFromConfig", () => {
  test("two server blocks in one file stay separate", () => {
    const vhosts = vhostsFromConfig(HUB, "/etc/nginx/sites-enabled/hub");
    assert.equal(vhosts.length, 2);
    // The :443 block owns the proxy_pass...
    const tls = vhosts.find((v) => v.listens.some((l) => l.port === 443));
    assert.deepEqual(tls?.upstreams, ["http://127.0.0.1:3000"]);
    assert.equal(tls?.listens[0].ssl, true);
    assert.equal(
      tls?.ssl_certificate,
      "/etc/letsencrypt/live/hub.schreinercontentsystems.com/fullchain.pem",
    );
    assert.deepEqual(tls?.roots, ["/opt/content-forge/apps/hub-web/.next/static/"]);
    // ...and the :80 redirect block must NOT inherit it. This is the assertion
    // that fails for every regex implementation of this parser.
    const plain = vhosts.find((v) => v.listens.some((l) => l.port === 80));
    assert.deepEqual(plain?.upstreams, []);
    assert.equal(plain?.listens[0].ssl, false);
    assert.equal(plain?.ssl_certificate, null);
  });

  test("a commented-out server_name is not a domain", () => {
    const vhosts = vhostsFromConfig(
      "server { # server_name ghost.example.com;\n server_name real.example.com; }",
      "f",
    );
    assert.deepEqual(vhosts[0].server_names, ["real.example.com"]);
  });

  test("multiple names on one server_name line all appear", () => {
    const vhosts = vhostsFromConfig(
      "server { server_name a.example.com b.example.com; listen 443 ssl; }",
      "f",
    );
    assert.deepEqual(vhosts[0].server_names, ["a.example.com", "b.example.com"]);
  });

  test("an IPv6/host:port listen still yields the port", () => {
    const vhosts = vhostsFromConfig("server { listen [::]:8443 ssl; }", "f");
    assert.equal(vhosts[0].listens[0].port, 8443);
    assert.equal(vhosts[0].listens[0].ssl, true);
  });

  test("a `server` line inside an upstream block is not a vhost", () => {
    const vhosts = vhostsFromConfig(
      "upstream app { server 127.0.0.1:3000; }\nserver { server_name x.example.com; }",
      "f",
    );
    assert.equal(vhosts.length, 1);
    assert.deepEqual(vhosts[0].server_names, ["x.example.com"]);
  });

  test("include is reported, not silently missing", () => {
    const vhosts = vhostsFromConfig(
      "server { include snippets/ssl.conf; server_name x; }",
      "f",
    );
    assert.deepEqual(vhosts[0].unresolved_includes, ["snippets/ssl.conf"]);
  });
});

describe("readCertificateExpiry", () => {
  test("a missing certificate reports the reason instead of throwing", async () => {
    const res = await readCertificateExpiry("/nonexistent/fullchain.pem");
    assert.equal(res.expires_at, null);
    assert.equal(res.days_left, null);
    assert.match(res.error ?? "", /cannot read certificate/);
  });

  test("a file that is not a certificate reports a parse failure", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nginx-cert-"));
    const bogus = path.join(dir, "fullchain.pem");
    writeFileSync(bogus, "not a certificate");
    try {
      const res = await readCertificateExpiry(bogus);
      assert.equal(res.expires_at, null);
      assert.match(res.error ?? "", /cannot parse certificate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readNginxVhosts", () => {
  test("reads a sites-enabled directory of symlinks and isolates bad files", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "nginx-sites-"));
    const available = path.join(base, "sites-available");
    const enabled = path.join(base, "sites-enabled");
    rmSync(enabled, { recursive: true, force: true });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(available, { recursive: true });
    mkdirSync(enabled, { recursive: true });
    // The certificate path is rewritten to one that cannot exist. The real
    // one in HUB is a LIVE path on this box and readable as root, so the
    // ssl_error assertion below would pass or fail depending on the machine.
    writeFileSync(
      path.join(available, "hub"),
      HUB.replace("/etc/letsencrypt/live/", "/nonexistent/letsencrypt/live/"),
    );
    symlinkSync(path.join(available, "hub"), path.join(enabled, "hub"));
    // A dangling symlink: stat fails, and that file must be NAMED in errors[]
    // rather than quietly reducing the domain count.
    symlinkSync(path.join(available, "gone"), path.join(enabled, "gone"));
    try {
      const scan = await readNginxVhosts(enabled);
      assert.equal(scan.vhosts.length, 2);
      assert.equal(scan.files.length, 1);
      assert.equal(scan.errors.length, 1);
      assert.match(scan.errors[0].file, /gone$/);
      // The certificate path in the fixture does not exist here, so the row
      // carries an explicit ssl_error rather than a silent null expiry.
      const tls = scan.vhosts.find((v) => v.ssl_certificate !== null);
      assert.match(tls?.ssl_error ?? "", /cannot read certificate/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("an unreadable directory throws (the section reports it, never zero domains)", async () => {
    await assert.rejects(
      () => readNginxVhosts("/nonexistent/sites-enabled"),
      /cannot read nginx site directory/,
    );
  });
});
