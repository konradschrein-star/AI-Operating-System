/**
 * Tests for lib/vault-layout.ts — the flag that decides whether the vault is
 * flat or split, and the folder resolvers every writer asks for its
 * destination. PLAN.md §3.5.
 *
 * Run: pnpm test   (tsx --test src/lib/*.test.ts — a test anywhere else does
 * not run at all)
 *
 * EVERY assertion is flipped across its boundary in BOTH directions
 * (03-quality.md): a resolver test that only checks `split` passes against a
 * module that ignores the flag and hardcodes `Forge/`, and a rejection test
 * with no accepted value passes against a parser that rejects everything.
 *
 * Nothing here touches a filesystem — this module only computes strings.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  layout,
  parseVaultLayoutName,
  VAULT_LAYOUT_NAMES,
  type VaultLayoutName,
} from "./vault-layout.ts";

/** The module reads the env on every call, so a test sets it and puts it back.
 *  `delete` (not `= undefined`) — an env var set to the string "undefined" is
 *  exactly the junk value the parser is supposed to reject. */
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    previous.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    body();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

afterEach(() => {
  // A leaked VAULT_LAYOUT would silently re-point every later test in this
  // file; assert the restore actually happened rather than trusting it.
  assert.equal(process.env.VAULT_LAYOUT, undefined, "a test leaked VAULT_LAYOUT");
});

describe("layout() rejects junk — a third value is an error, never a fallback", () => {
  const JUNK = [
    "Split", // capitalised: the shell copy-paste mistake
    "SPLIT",
    "splt",
    "true",
    "1",
    "legacy split",
    " split",
    "split ",
    "undefined",
    "null",
    "konrad",
    "Forge/",
  ];

  for (const raw of JUNK) {
    test(`VAULT_LAYOUT=${JSON.stringify(raw)} throws, naming both legal values`, () => {
      withEnv({ VAULT_LAYOUT: raw }, () => {
        assert.throws(
          () => layout(),
          (e: unknown) => {
            assert.ok(e instanceof Error);
            assert.match(e.message, /VAULT_LAYOUT/);
            assert.match(e.message, /"legacy"/);
            assert.match(e.message, /"split"/);
            // The rejected value itself must be in the message — an error that
            // does not say what it read sends the operator to the wrong file.
            assert.ok(
              e.message.includes(JSON.stringify(raw)),
              `the message must quote the offending value, got: ${e.message}`,
            );
            return true;
          },
        );
      });
    });
  }

  // The flip: the two legal values, and absence, do NOT throw. Without these
  // three the suite above passes against `layout() { throw }`.
  test("legacy, split and an unset variable are accepted", () => {
    withEnv({ VAULT_LAYOUT: "legacy" }, () => assert.equal(layout().name, "legacy"));
    withEnv({ VAULT_LAYOUT: "split" }, () => assert.equal(layout().name, "split"));
    withEnv({ VAULT_LAYOUT: undefined }, () => assert.equal(layout().name, "legacy"));
    // The empty string is what an `ENV=` line in an ecosystem file produces —
    // "the operator did not set it", not junk.
    withEnv({ VAULT_LAYOUT: "" }, () => assert.equal(layout().name, "legacy"));
  });

  test("parseVaultLayoutName is the single parser, and it agrees with layout()", () => {
    for (const name of VAULT_LAYOUT_NAMES) {
      assert.equal(parseVaultLayoutName(name), name);
      withEnv({ VAULT_LAYOUT: name }, () => assert.equal(layout().name, name));
    }
    assert.equal(parseVaultLayoutName(undefined), "legacy");
    assert.throws(() => parseVaultLayoutName("Split"), /VAULT_LAYOUT/);
  });
});

describe("roots: empty under legacy, two folders under split", () => {
  test("legacy roots are both empty strings", () => {
    withEnv({ VAULT_LAYOUT: "legacy" }, () => {
      assert.deepEqual(layout().roots, { human: "", agent: "" });
    });
  });

  test("split roots are Konrad/ and Forge/, trailing slash included", () => {
    withEnv({ VAULT_LAYOUT: "split" }, () => {
      assert.deepEqual(layout().roots, { human: "Konrad/", agent: "Forge/" });
    });
  });

  test("the roots object cannot be mutated into the next caller's layout", () => {
    withEnv({ VAULT_LAYOUT: "split" }, () => {
      const first = layout();
      // A shared const returned by reference would let one caller's edit reach
      // every later caller. Whether or not this write lands, the SECOND call
      // must still describe the real layout.
      try {
        (first.roots as { agent: string }).agent = "Tampered/";
      } catch {
        // frozen is a fine answer too
      }
      assert.equal(layout().roots.agent, "Forge/");
    });
  });
});

describe("folder resolvers", () => {
  const EXPECTED: Record<VaultLayoutName, Record<string, string>> = {
    legacy: {
      dailyDir: "Daily",
      inboxDir: "Inbox",
      mentorDir: "Mentor",
      journalDir: "Journal",
    },
    split: {
      dailyDir: "Forge/Daily",
      inboxDir: "Forge/Inbox",
      mentorDir: "Forge/Mentor",
      journalDir: "Konrad/Journal",
    },
  };

  for (const name of VAULT_LAYOUT_NAMES) {
    test(`${name}: every resolver`, () => {
      withEnv(
        { VAULT_LAYOUT: name, VAULT_DAILY_DIR: undefined, VAULT_INBOX_DIR: undefined },
        () => {
          const l = layout();
          assert.equal(l.dailyDir(), EXPECTED[name].dailyDir);
          assert.equal(l.inboxDir(), EXPECTED[name].inboxDir);
          assert.equal(l.mentorDir(), EXPECTED[name].mentorDir);
          assert.equal(l.journalDir(), EXPECTED[name].journalDir);
        },
      );
    });
  }

  test("the journal is on the HUMAN side and the daily note is not", () => {
    // The one distinction the whole split exists for: his writing and the OS's
    // writing do not share a root. A resolver set that put both under one root
    // would pass every per-value test above.
    withEnv({ VAULT_LAYOUT: "split" }, () => {
      const l = layout();
      assert.ok(l.journalDir().startsWith(l.roots.human));
      assert.ok(!l.journalDir().startsWith(l.roots.agent));
      for (const dir of [l.dailyDir(), l.inboxDir(), l.mentorDir()]) {
        assert.ok(dir.startsWith(l.roots.agent), `${dir} must be on the agent side`);
      }
    });
    // Flip: under legacy nothing is under either root, because there are none.
    withEnv({ VAULT_LAYOUT: "legacy" }, () => {
      const l = layout();
      assert.equal(l.journalDir(), "Journal");
      assert.equal(l.dailyDir(), "Daily");
    });
  });

  test("VAULT_DAILY_DIR / VAULT_INBOX_DIR still override, and gain the root", () => {
    withEnv(
      { VAULT_LAYOUT: "split", VAULT_DAILY_DIR: "Journalling", VAULT_INBOX_DIR: "Capture" },
      () => {
        assert.equal(layout().dailyDir(), "Forge/Journalling");
        assert.equal(layout().inboxDir(), "Forge/Capture");
      },
    );
    withEnv(
      { VAULT_LAYOUT: "legacy", VAULT_DAILY_DIR: "Journalling", VAULT_INBOX_DIR: "Capture" },
      () => {
        assert.equal(layout().dailyDir(), "Journalling");
        assert.equal(layout().inboxDir(), "Capture");
      },
    );
  });

  test("a trailing or leading slash in the override is normalised, not doubled", () => {
    withEnv({ VAULT_LAYOUT: "split", VAULT_DAILY_DIR: "Daily/" }, () => {
      assert.equal(layout().dailyDir(), "Forge/Daily");
    });
    withEnv({ VAULT_LAYOUT: "split", VAULT_DAILY_DIR: "./Daily" }, () => {
      assert.equal(layout().dailyDir(), "Forge/Daily");
    });
    withEnv({ VAULT_LAYOUT: "legacy", VAULT_DAILY_DIR: "/Daily/" }, () => {
      assert.equal(layout().dailyDir(), "Daily");
    });
  });

  test("an override that normalises to nothing throws — it would write to the vault root", () => {
    for (const raw of ["", "   ", "/", "///", "./"]) {
      withEnv({ VAULT_LAYOUT: "legacy", VAULT_DAILY_DIR: raw }, () => {
        assert.throws(() => layout().dailyDir(), /VAULT_DAILY_DIR/);
      });
      withEnv({ VAULT_LAYOUT: "split", VAULT_INBOX_DIR: raw }, () => {
        assert.throws(() => layout().inboxDir(), /VAULT_INBOX_DIR/);
      });
    }
    // Flip: a one-character folder name is fine — the guard is about EMPTY,
    // not about short.
    withEnv({ VAULT_LAYOUT: "legacy", VAULT_DAILY_DIR: "D" }, () => {
      assert.equal(layout().dailyDir(), "D");
    });
  });
});

describe("thoughtsRoots() — the shape B3's lib/thoughts.ts exposes", () => {
  test("exactly four string keys, in both layouts", () => {
    for (const name of VAULT_LAYOUT_NAMES) {
      withEnv({ VAULT_LAYOUT: name }, () => {
        const roots = layout().thoughtsRoots();
        assert.deepEqual(Object.keys(roots).sort(), ["dreams", "ideas", "quotes", "seeds"]);
        for (const [key, value] of Object.entries(roots)) {
          assert.equal(typeof value, "string", `${key} must be a string`);
          assert.ok(value.length > 0);
        }
      });
    }
  });

  test("legacy: flat paths", () => {
    withEnv({ VAULT_LAYOUT: "legacy" }, () => {
      assert.deepEqual(layout().thoughtsRoots(), {
        ideas: "Thoughts/Ideas",
        seeds: "Thoughts/Seeds",
        quotes: "Thoughts/Quotes.md",
        dreams: "Thoughts/Dreams.md",
      });
    });
  });

  test("split: his ideas are his, the derived seeds are the fleet's", () => {
    withEnv({ VAULT_LAYOUT: "split" }, () => {
      assert.deepEqual(layout().thoughtsRoots(), {
        ideas: "Konrad/Thoughts/Ideas",
        seeds: "Forge/Thoughts/Seeds",
        quotes: "Konrad/Thoughts/Quotes.md",
        dreams: "Konrad/Thoughts/Dreams.md",
      });
    });
  });

  test("ideas and seeds are directories; quotes and dreams are .md files", () => {
    // PLAN.md §3.2 — a consumer that path.join()s a filename onto `quotes`
    // writes `Thoughts/Quotes.md/2026-08-25-x.md`, so the asymmetry is pinned.
    for (const name of VAULT_LAYOUT_NAMES) {
      withEnv({ VAULT_LAYOUT: name }, () => {
        const roots = layout().thoughtsRoots();
        assert.ok(!roots.ideas.endsWith(".md"));
        assert.ok(!roots.seeds.endsWith(".md"));
        assert.ok(roots.quotes.endsWith(".md"));
        assert.ok(roots.dreams.endsWith(".md"));
      });
    }
  });
});

// cc-runner.ts prompt-wiring (the "cc-runner's vault paragraph is DERIVED
// from these resolvers" block) was reverted in the round-6 fix cycle: Gate 6
// forbids any project from editing cc-runner.ts — it is every fleet run's
// system prompt — without a dated OPERATOR WAIVER in gates-808.sh, and none
// was obtained before this landed. The resolvers/guard above are unaffected;
// only the prompt integration is deferred pending Konrad's go-ahead.
