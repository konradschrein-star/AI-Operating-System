/**
 * Tests for the MAP surface's tree builder.
 *
 * Run: npx tsx --test app/desktop/map/mapTree.test.ts
 * (node --test via tsx, the same runner as goals/quick-add.test.ts and
 * forge-control/src/lib/*.test.ts — no framework, and `buildMapTree` imports
 * nothing that needs a DOM.)
 *
 * WHAT THESE PIN, and why they are not "the mapper maps".
 *
 * The round-3 MAP failed review for shipping invented nodes: GitHub links that
 * answer 404, `domain` fields naming vhosts /etc/nginx has never had, and a
 * datastore list that read "Listening" whether or not anything was. Those are
 * not rendering bugs — they are the absence of an invariant. So the tests below
 * pin the invariant itself:
 *
 *   1. EVERY node, at every depth, carries a source and a checked-at. A node
 *      with no producer behind it cannot exist.
 *   2. Every link is derived from a measurement — a server_name nginx is
 *      configured with — never from a constant.
 *   3. Deleting a thing from the payload deletes its node. If a node can
 *      survive its evidence disappearing, the map is a picture again.
 *   4. A failed section darkens ITS column with the server's own error text
 *      and produces no nodes. This is the one round 3 got exactly backwards:
 *      it silently substituted a 16-row mock and left the error state dead.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildMapTree, walkNodes, nodeMatches } from "./mapTree";
import { namedVhosts } from "./mapApi";
import type { MapPayload } from "./mapApi";

/* ── Fixture ─────────────────────────────────────────────────────────────────
 * Shapes and values are trimmed from a real `GET /api/map` on VPS1 taken
 * 2026-08-23 (see evidence/library-map-verification.md), so the field names
 * here are the ones the route actually emits, not ones invented for a test. */

const AT = "2026-08-23T16:20:00.000Z";

function payload(overrides: Partial<MapPayload["sections"]> = {}): MapPayload {
  return {
    generated_at: AT,
    host: { name: "VPS1", ip: "65.108.6.149" },
    failed_sections: [],
    sections: {
      businesses: {
        ok: true,
        checked_at: AT,
        source: "/opt/obsidian-vault/90_AI_OS/Konrad Projects Overview.md",
        data: {
          note: "90_AI_OS/Konrad Projects Overview.md",
          note_mtime: AT,
          active: 2,
          archived: 1,
          projects: [
            {
              name: "Project - Content Forge",
              status: "Active",
              type: "Core platform / video production",
              deployed: "/opt/content-forge",
              path_exists: true,
            },
            {
              name: "Project - Schichtkommunikationstool",
              status: "Active",
              type: "SaaS MVP / client product",
              deployed: "/opt/schichtkommunikationstool",
              path_exists: false,
            },
            {
              name: "Project - Teleprompter",
              status: "Archived",
              type: "Desktop utility",
              deployed: "Local only",
              path_exists: null,
            },
          ],
        },
      },
      processes: {
        ok: true,
        checked_at: AT,
        source: "pm2 jlist",
        data: {
          count: 3,
          online: 2,
          processes: [
            {
              name: "worker-render",
              pid: 1234,
              status: "online",
              restarts: 2,
              uptime_ms: 90_000_000,
              cpu_pct: 3,
              memory_bytes: 512_000_000,
              cwd: "/opt/content-forge",
              script: "index.js",
            },
            {
              name: "forge-control",
              pid: 2345,
              status: "online",
              restarts: 0,
              uptime_ms: 3_600_000,
              cpu_pct: 1,
              memory_bytes: 128_000_000,
              cwd: "/opt/forge-ai-os/forge-control",
              script: "index.ts",
            },
            {
              name: "thumbnail-tool",
              pid: null,
              status: "stopped",
              restarts: 9,
              uptime_ms: 0,
              cpu_pct: 0,
              memory_bytes: 0,
              cwd: "/opt/thumbnail-generator",
              script: "server.js",
            },
          ],
        },
      },
      units: {
        ok: true,
        checked_at: AT,
        source: "systemctl list-units",
        data: {
          count: 1,
          units: [
            { name: "nginx.service", active: "active", sub: "running", description: "A high performance web server" },
          ],
        },
      },
      domains: {
        ok: true,
        checked_at: AT,
        source: "/etc/nginx/sites-enabled",
        data: {
          dir: "/etc/nginx/sites-enabled",
          files: 4,
          count: 6,
          errors: [],
          /* SIX rows, THREE names. The route emits one row per
           * (server_name × server block), so the ordinary :80-redirect +
           * :443-TLS pair arrives twice under one name — on the real box, 37
           * rows for 18 names. `os` has its TLS block first, `hub` has it
           * second: the merge must find the certificate either way. */
          domains: [
            {
              domain: "os.schreinercontentsystems.com",
              file: "os.conf",
              ports: [443],
              ssl: true,
              upstreams: ["http://127.0.0.1:7701"],
              roots: [],
              ssl_expires_at: "2026-11-15T00:00:00.000Z",
              ssl_days_left: 84,
              ssl_error: null,
            },
            {
              domain: "os.schreinercontentsystems.com",
              file: "os.conf",
              ports: [80],
              ssl: false,
              upstreams: [],
              roots: ["/var/www/certbot"],
              ssl_expires_at: null,
              ssl_days_left: null,
              ssl_error: null,
            },
            {
              domain: "hub.schreinercontentsystems.com",
              file: "hub.conf",
              ports: [80],
              ssl: false,
              upstreams: [],
              roots: ["/var/www/certbot"],
              ssl_expires_at: null,
              ssl_days_left: null,
              ssl_error: null,
            },
            {
              domain: "hub.schreinercontentsystems.com",
              file: "hub.conf",
              ports: [443],
              ssl: true,
              upstreams: ["http://127.0.0.1:7702"],
              roots: [],
              ssl_expires_at: "2026-09-01T00:00:00.000Z",
              ssl_days_left: 9,
              ssl_error: null,
            },
            // A name with no TLS block anywhere — the bare IP on the real box.
            {
              domain: "65.108.6.149",
              file: "default-ip.conf",
              ports: [80],
              ssl: false,
              upstreams: [],
              roots: [],
              ssl_expires_at: null,
              ssl_days_left: null,
              ssl_error: null,
            },
            // The catch-all server. It answers for no name and must not be
            // counted as one of Konrad's front doors.
            {
              domain: "_",
              file: "default.conf",
              ports: [80],
              ssl: false,
              upstreams: [],
              roots: [],
              ssl_expires_at: null,
              ssl_days_left: null,
              ssl_error: null,
            },
          ],
        },
      },
      storage: {
        ok: true,
        checked_at: AT,
        source: "df -B1 -P, /proc/meminfo, ss -ltnpH",
        data: {
          disks: [
            {
              mount: "/",
              total_bytes: 971_968_172_032,
              used_bytes: 714_069_307_392,
              available_bytes: 208_450_154_496,
              used_pct: 75.9,
            },
          ],
          memory: {
            total_bytes: 67_346_612_224,
            used_bytes: 42_824_200_192,
            available_bytes: 24_522_412_032,
            used_pct: 63.6,
          },
          datastores: [
            { name: "PostgreSQL :5434", port: 5434, listening: true, process: "postgres" },
            { name: "Ollama :11434", port: 11434, listening: false, process: null },
          ],
          listeners: [{ port: 5434, process: "postgres", address: "127.0.0.1:5434" }],
        },
      },
      canvases: {
        ok: true,
        checked_at: AT,
        source: "vault *.excalidraw.md",
        data: {
          count: 1,
          canvases: [
            {
              path: "Excalidraw/Planning Canvas.excalidraw.md",
              name: "Planning Canvas",
              folder: "Excalidraw",
              mtime: AT,
              size: 4096,
            },
          ],
        },
      },
      ...overrides,
    },
  };
}

function allNodes(p: MapPayload) {
  const tree = buildMapTree(p);
  const nodes = tree.branches.flatMap((b) => walkNodes(b.nodes));
  return { tree, nodes };
}

/* ── 1. Provenance is structural, not decorative ─────────────────────────── */

describe("provenance", () => {
  test("every node at every depth names the producer that measured it", () => {
    const { tree, nodes } = allNodes(payload());
    assert.ok(nodes.length > 10, "fixture should produce a non-trivial tree");
    for (const n of [...nodes, tree.root!]) {
      assert.notEqual(n.source, "", `node ${n.id} has an empty source`);
      assert.ok(n.source.length > 2, `node ${n.id} has a placeholder source`);
      assert.ok(
        !Number.isNaN(Date.parse(n.checkedAt)),
        `node ${n.id} has an unparseable checkedAt: ${n.checkedAt}`,
      );
    }
  });

  test("every node's status is spelled out in words as well as a colour", () => {
    const { nodes } = allNodes(payload());
    for (const n of nodes) {
      assert.notEqual(n.statusLabel.trim(), "", `node ${n.id} has no statusLabel`);
    }
  });
});

/* ── 2. Links come from measurements ─────────────────────────────────────── */

describe("links", () => {
  test("the only external links are https:// on a server_name nginx serves", () => {
    const { nodes } = allNodes(payload());
    const linked = nodes.filter((n) => n.publicUrl !== undefined);
    assert.deepEqual(
      linked.map((n) => n.publicUrl),
      [
        "https://os.schreinercontentsystems.com",
        "https://hub.schreinercontentsystems.com",
      ],
      "a link appeared that nginx did not authorise",
    );
  });

  test("a name with no TLS block anywhere gets no link", () => {
    const { nodes } = allNodes(payload());
    const http = nodes.find((n) => n.type === "domain" && n.statusLabel.includes("plain HTTP"));
    assert.ok(http, "the HTTP-only vhost should still be a node");
    assert.equal(http.label, "65.108.6.149");
    assert.equal(http.publicUrl, undefined);
  });

  test("the nginx catch-all server is not counted as one of Konrad's domains", () => {
    const { nodes } = allNodes(payload());
    assert.equal(
      nodes.filter((n) => n.type === "domain" && n.label === "_").length,
      0,
      "`server_name _` answers for no name and must not appear",
    );
    const ingress = nodes.find((n) => n.id === "ingress-nginx");
    assert.ok(ingress);
    assert.match(ingress.label, /3 server names/);
  });
});

/* ── 2b. A name is counted once, however many blocks declare it ──────────── */

describe("server names are names, not server blocks", () => {
  test("the :80 and :443 blocks of one name are one node, one count", () => {
    const { nodes } = allNodes(payload());
    const os = nodes.filter(
      (n) => n.type === "domain" && n.label === "os.schreinercontentsystems.com",
    );
    assert.equal(os.length, 1, "one name, one node — the pair must be merged");

    const ingress = nodes.find((n) => n.id === "ingress-nginx");
    assert.ok(ingress);
    // 6 rows in the payload, 3 names on the box: os, hub, the bare IP.
    assert.match(ingress.label, /3 server names/);
    assert.equal(
      ingress.facts.find((f) => f.label === "Server names")?.value,
      "3",
      "the ingress fact must count what the label counts",
    );
    assert.equal(
      ingress.facts.find((f) => f.label === "Vhost files")?.value,
      "4",
      "files stay files — only the name count is deduped",
    );
  });

  test("the merged node keeps every port and the certificate of the TLS block", () => {
    const { nodes } = allNodes(payload());
    // `hub` is the hard ordering: its plain :80 block is listed BEFORE the
    // :443 one, so taking the first row's fields would report no certificate.
    const hub = nodes.find(
      (n) => n.type === "domain" && n.label === "hub.schreinercontentsystems.com",
    );
    assert.ok(hub);
    assert.equal(hub.facts.find((f) => f.label === "Ports")?.value, "80, 443");
    assert.equal(hub.facts.find((f) => f.label === "Certificate")?.value, "expires 2026-09-01");
    assert.equal(hub.statusLabel, "TLS · 9 days left");
    assert.equal(hub.status, "partial", "9 days left is amber, not green");
    assert.equal(hub.publicUrl, "https://hub.schreinercontentsystems.com");
    assert.equal(
      hub.facts.find((f) => f.label === "Upstreams")?.value,
      "http://127.0.0.1:7702",
      "the upstream of the TLS block must survive the merge",
    );
  });

  test("only the names with TLS are reported as having it", () => {
    const { nodes } = allNodes(payload());
    const ingress = nodes.find((n) => n.id === "ingress-nginx");
    assert.ok(ingress);
    // 4 of the 6 rows carry ssl:true or sit beside one; 2 of the 3 NAMES do.
    assert.equal(ingress.facts.find((f) => f.label === "With TLS")?.value, "2");
  });

  test("the header chip and the ingress node count the same list", () => {
    // MapSurface's chip and the tree both call namedVhosts(), so the number
    // Konrad reads at the top is the number the node under it shows.
    const rows = payload().sections.domains;
    assert.ok(rows && rows.ok);
    const chip = namedVhosts(rows.data.domains).length;
    const ingress = allNodes(payload()).nodes.find((n) => n.id === "ingress-nginx");
    assert.ok(ingress);
    assert.equal(ingress.facts.find((f) => f.label === "Server names")?.value, String(chip));
    assert.equal(chip, 3);
  });
});

/* ── 3. Delete the evidence, delete the node ─────────────────────────────── */

describe("nothing survives its evidence", () => {
  test("a project removed from the vault note vanishes from the map", () => {
    const before = allNodes(payload()).nodes;
    assert.ok(before.some((n) => n.label === "Content Forge"));

    const p = payload();
    const biz = p.sections.businesses;
    assert.ok(biz && biz.ok);
    biz.data.projects = biz.data.projects.filter((x) => x.name !== "Project - Content Forge");

    const after = allNodes(p).nodes;
    assert.equal(after.some((n) => n.label === "Content Forge"), false);
  });

  test("a datastore that is not listening says so, and the reverse", () => {
    const { nodes } = allNodes(payload());
    const pg = nodes.find((n) => n.id === "ds-5434");
    const ollama = nodes.find((n) => n.id === "ds-11434");
    assert.ok(pg && ollama);
    assert.equal(pg.status, "up");
    assert.match(pg.statusLabel, /listening on :5434 \(postgres\)/);
    assert.equal(ollama.status, "down");
    assert.match(ollama.statusLabel, /nothing is listening on :11434/);
  });

  test("a vault path that is not on this box is red and names the discrepancy", () => {
    const { nodes } = allNodes(payload());
    const shift = nodes.find((n) => n.label === "Schichtkommunikationstool");
    assert.ok(shift);
    assert.equal(shift.status, "down");
    assert.match(shift.statusLabel, /named in the vault note but is not on this box/);
  });

  test("a project with no local deployment claims nothing about this host", () => {
    const { nodes } = allNodes(payload());
    const tele = nodes.find((n) => n.label === "Teleprompter");
    assert.ok(tele);
    assert.equal(tele.status, "neutral");
    assert.match(tele.statusLabel, /nothing to measure here/);
  });

  test("a business is green only because pm2 processes were found under its path", () => {
    const { nodes } = allNodes(payload());
    const cf = nodes.find((n) => n.label === "Content Forge");
    assert.ok(cf);
    assert.equal(cf.status, "up");
    assert.match(cf.statusLabel, /1\/1 pm2 process online at \/opt\/content-forge/);
    assert.deepEqual((cf.children ?? []).map((c) => c.label), ["worker-render"]);
  });

  test("a business with a stopped process is amber, and red when all are down", () => {
    const withStitch = (status: string) => {
      const p = payload();
      const procs = p.sections.processes;
      assert.ok(procs && procs.ok);
      procs.data.processes.push({
        name: "worker-stitch",
        pid: null,
        status,
        restarts: 0,
        uptime_ms: 0,
        cpu_pct: 0,
        memory_bytes: 0,
        cwd: "/opt/content-forge/apps/stitch",
        script: "stitch.js",
      });
      return p;
    };

    const amber = allNodes(withStitch("stopped")).nodes.find((n) => n.label === "Content Forge");
    assert.ok(amber);
    assert.equal(amber.status, "partial", "1 of 2 online must not read as healthy");
    assert.match(amber.statusLabel, /1\/2 pm2 processes online/);

    // …and with the last survivor stopped too, red.
    const dead = withStitch("stopped");
    const procs = dead.sections.processes;
    assert.ok(procs && procs.ok);
    procs.data.processes[0].status = "stopped";
    const red = allNodes(dead).nodes.find((n) => n.label === "Content Forge");
    assert.ok(red);
    assert.equal(red.status, "down");
    assert.match(red.statusLabel, /0\/2 pm2 processes online/);
  });

  test("a partly-online process group is amber, not green", () => {
    const p = payload();
    const procs = p.sections.processes;
    assert.ok(procs && procs.ok);
    procs.data.processes.push({
      name: "worker-stitch",
      pid: null,
      status: "stopped",
      restarts: 0,
      uptime_ms: 0,
      cpu_pct: 0,
      memory_bytes: 0,
      cwd: "/opt/content-forge",
      script: "stitch.js",
    });
    const { nodes } = allNodes(p);
    const group = nodes.find((n) => n.id === "grp-opt-content-forge");
    assert.ok(group);
    assert.equal(group.status, "partial");
    assert.equal(group.statusLabel, "1/2 online");
  });
});

/* ── 4. A failed section is an error on screen, never a substitute ───────── */

describe("sectional error isolation", () => {
  test("a failed businesses section darkens its own column with the server's text", () => {
    const p = payload({
      businesses: {
        ok: false,
        checked_at: AT,
        source: "the vault note",
        error: '"## All Projects" heading not found — the note was restructured',
      },
    });
    const tree = buildMapTree(p);
    const businesses = tree.branches.find((b) => b.key === "businesses");
    assert.ok(businesses);
    assert.equal(businesses.nodes.length, 0, "a dead section must produce no nodes");
    assert.match(businesses.error ?? "", /All Projects.*heading not found/);
  });

  test("a failed section does not take the other columns down with it", () => {
    const p = payload({
      processes: {
        ok: false,
        checked_at: AT,
        source: "pm2 jlist",
        error: "pm2 jlist failed: command not found",
      },
    });
    const tree = buildMapTree(p);
    const runtime = tree.branches.find((b) => b.key === "runtime");
    const infra = tree.branches.find((b) => b.key === "infrastructure");
    assert.match(runtime?.error ?? "", /command not found/);
    assert.equal(infra?.error, null);
    assert.ok((infra?.nodes.length ?? 0) > 0, "infrastructure must still render");
  });

  test("with pm2 dead, a business shows its path check and no invented processes", () => {
    const p = payload({
      processes: {
        ok: false,
        checked_at: AT,
        source: "pm2 jlist",
        error: "pm2 jlist failed",
      },
    });
    const { nodes } = allNodes(p);
    const cf = nodes.find((n) => n.label === "Content Forge");
    assert.ok(cf);
    assert.equal(cf.children, undefined);
    assert.match(cf.statusLabel, /exists on this box, no pm2 process runs from it/);
  });

  test("an absent section is named rather than rendered as empty", () => {
    const p = payload();
    delete p.sections.businesses;
    const tree = buildMapTree(p);
    const businesses = tree.branches.find((b) => b.key === "businesses");
    assert.match(businesses?.error ?? "", /returned no "businesses" section/);
  });

  test("the root repeats the aggregator's own failed_sections list", () => {
    const p = payload();
    p.failed_sections = ["storage"];
    const tree = buildMapTree(p);
    assert.equal(tree.root?.status, "partial");
    assert.match(tree.root?.statusLabel ?? "", /sections unavailable: storage/);
  });
});

/* ── 5. Search ───────────────────────────────────────────────────────────── */

describe("nodeMatches", () => {
  test("an empty query matches everything", () => {
    const { nodes } = allNodes(payload());
    assert.ok(nodes.every((n) => nodeMatches(n, "")));
  });

  test("a parent is kept when only a descendant matches", () => {
    const { nodes } = allNodes(payload());
    const cf = nodes.find((n) => n.label === "Content Forge");
    assert.ok(cf);
    assert.equal(cf.label.toLowerCase().includes("worker-render"), false);
    assert.equal(nodeMatches(cf, "worker-render"), true);
  });

  test("a port typed into the box finds the vhost that listens on it", () => {
    const { nodes } = allNodes(payload());
    const ingress = nodes.find((n) => n.id === "ingress-nginx");
    assert.ok(ingress);
    assert.equal(nodeMatches(ingress, "7701"), true);
    assert.equal(nodeMatches(ingress, "9999"), false);
  });
});
