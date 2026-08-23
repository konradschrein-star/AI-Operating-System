/**
 * The built-in protected-skills layer must protect skills that EXIST.
 *
 * Run: pnpm test   (node --test via tsx — the script globs src/lib/*.test.ts,
 * which is why a test for src/services/skills-curator.ts lives here.)
 *
 * ── WHAT THIS FILE GUARDS ───────────────────────────────────────────────────
 * `DEFAULT_PROTECTED_IDS` used to read
 *   ["user:graphify", "user:gemini-video-review", "user:plan"]
 * with a source comment calling them "harmless on the VPS where
 * USER_SKILLS_DIR is empty". It is not empty: `listSkills()` discovers 142
 * skills here, 51 of them `user:`-sourced, and NONE of those three ids is
 * among them. So the layer the brief asked for — "some skills must not be
 * disabled; respect that and say why in the UI" — protected zero real skills,
 * and every one of the 142 (including `user:brainstorming`, whose description
 * opens "You MUST use this before any creative work") was one click from being
 * dropped out of every agent's context.
 *
 * A protected id is a string, and a string that no longer resolves fails
 * silently and forever. This test is the only thing that turns that into a
 * red run instead of an incident. It reads the REAL catalog off the
 * filesystem — no database, no network — so it is honest on this host and will
 * correctly go red on a host where the skills simply are not installed.
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import { listSkills, type SkillSummary } from "../db/skills.ts";
import {
  PROTECTED_SKILL_ID_LIST,
  isProtectedSkill,
  protectedSkillReason,
} from "../services/skills-curator.ts";

describe("DEFAULT_PROTECTED_IDS resolves against this host's real catalog", () => {
  let catalog: SkillSummary[] = [];
  let ids = new Set<string>();

  before(async () => {
    const { skills } = await listSkills();
    catalog = skills;
    ids = new Set(skills.map((s) => s.id));
  });

  test("the catalog is non-empty, or every assertion below is vacuous", () => {
    assert.ok(
      catalog.length > 0,
      "listSkills() found no skills — a protected-id test against an empty " +
        "catalog proves nothing, which is exactly how the old list survived",
    );
  });

  test("every protected id names a skill that exists", () => {
    const missing = PROTECTED_SKILL_ID_LIST.filter((id) => !ids.has(id));
    assert.deepEqual(
      missing,
      [],
      `these protected ids resolve to nothing on this host, so they protect ` +
        `nothing: ${missing.join(", ")}. Either the skill moved (update the id) ` +
        `or it is gone (drop it). Do not leave a dead guard in the list.`,
    );
  });

  test("the list is not empty — an empty guard is the same defect", () => {
    assert.ok(PROTECTED_SKILL_ID_LIST.length > 0);
  });

  test("every protected id carries a reason the UI can print", () => {
    for (const id of PROTECTED_SKILL_ID_LIST) {
      const reason = protectedSkillReason(id);
      assert.ok(
        reason && reason.length > 20,
        `${id} has no usable protected_reason — the UI would print a locked ` +
          `toggle with no explanation, which is what the brief asked us to fix`,
      );
    }
  });

  test("isProtectedSkill and the exported list agree", () => {
    for (const id of PROTECTED_SKILL_ID_LIST) {
      assert.equal(isProtectedSkill(id), true, id);
    }
    assert.equal(isProtectedSkill("user:definitely-not-a-real-skill"), false);
  });

  test("the retired ids are gone", () => {
    // Named explicitly so a revert to the old list is a named failure rather
    // than a quiet one.
    for (const dead of ["user:graphify", "user:gemini-video-review", "user:plan"]) {
      assert.equal(
        PROTECTED_SKILL_ID_LIST.includes(dead),
        false,
        `${dead} does not exist in this host's catalog and must not be back`,
      );
    }
  });

  test("brainstorming is protected — the reviewer's named example", () => {
    assert.equal(isProtectedSkill("user:brainstorming"), true);
  });
});
