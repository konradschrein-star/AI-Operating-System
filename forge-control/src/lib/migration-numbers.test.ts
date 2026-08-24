/**
 * Unit tests for scripts/checks/check-migration-numbers.ts.
 *
 * Assertions:
 * 1. 4-digit zero-padded migration numbering uniqueness.
 * 2. Strict allowlisting of the applied historical 0040 pair ("0040_task_graph.sql", "0040_usage_hourly.sql").
 * 3. Failure on any new duplicate migration number.
 * 4. Failure on any 3rd file joining 0040 or mismatched 0040 pair.
 * 5. Failure on unnumbered files or invalid width (not 4 digits).
 * 6. Proper handling of missing, empty, or valid directories.
 * 7. Live db/migrations corpus passes cleanly with known debt acknowledged.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  MIGRATIONS_DIR,
  KNOWN_COLLISIONS,
  isKnownDebt,
  validateMigrationFiles,
  validateMigrationDir,
} from "../../../scripts/checks/check-migration-numbers.ts";

describe("check-migration-numbers unit suite", () => {
  describe("isKnownDebt helper", () => {
    test("recognises the historical 0040 pair in canonical order", () => {
      const files = ["0040_task_graph.sql", "0040_usage_hourly.sql"];
      assert.equal(isKnownDebt("0040", files), true);
    });

    test("recognises the historical 0040 pair in reverse order", () => {
      const files = ["0040_usage_hourly.sql", "0040_task_graph.sql"];
      assert.equal(isKnownDebt("0040", files), true);
    });

    test("refuses a 3rd file joining 0040 (triplicate collision)", () => {
      const files = [
        "0040_task_graph.sql",
        "0040_usage_hourly.sql",
        "0040_extra.sql",
      ];
      assert.equal(isKnownDebt("0040", files), false);
    });

    test("refuses a modified filename on 0040 (different pair)", () => {
      const files = ["0040_task_graph.sql", "0040_different.sql"];
      assert.equal(isKnownDebt("0040", files), false);
    });

    test("refuses a single file on 0040", () => {
      const files = ["0040_task_graph.sql"];
      assert.equal(isKnownDebt("0040", files), false);
    });

    test("refuses unknown migration number collisions (e.g. 0041, 0043)", () => {
      assert.equal(
        isKnownDebt("0043", ["0043_gemini_tier.sql", "0043_task_graph.sql"]),
        false,
      );
      assert.equal(
        isKnownDebt("0041", ["0041_foo.sql", "0041_bar.sql"]),
        false,
      );
    });

    test("supports custom known map for testing", () => {
      const customMap = new Map<string, string[]>([
        ["0010", ["0010_a.sql", "0010_b.sql"]],
      ]);
      assert.equal(isKnownDebt("0010", ["0010_b.sql", "0010_a.sql"], customMap), true);
      assert.equal(isKnownDebt("0010", ["0010_a.sql", "0010_c.sql"], customMap), false);
    });
  });

  describe("validateMigrationFiles (pure logic)", () => {
    test("passes on clean list of unique 4-digit zero-padded migrations", () => {
      const files = [
        "0001_initial.sql",
        "0002_users.sql",
        "0003_tasks.sql",
        "0004_projects.sql",
      ];
      const result = validateMigrationFiles(files);
      assert.equal(result.ok, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.highest, "0004");
      assert.equal(result.collisions.length, 0);
      assert.equal(result.unnumbered.length, 0);
      assert.equal(result.badWidth.length, 0);
      assert.equal(result.excused.length, 0);
    });

    test("passes on list containing the exact historical 0040 debt pair", () => {
      const files = [
        "0039_reviewer_chain_key.sql",
        "0040_task_graph.sql",
        "0040_usage_hourly.sql",
        "0041_settings.sql",
      ];
      const result = validateMigrationFiles(files);
      assert.equal(result.ok, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.collisions.length, 0);
      assert.equal(result.excused.length, 1);
      assert.equal(result.excused[0]![0], "0040");
      assert.deepEqual(
        result.excused[0]![1].sort(),
        ["0040_task_graph.sql", "0040_usage_hourly.sql"].sort(),
      );
    });

    test("fails on new duplicate migration numbers (e.g. two 0044 files)", () => {
      const files = [
        "0044_goals_and_calendar.sql",
        "0044_other_feature.sql",
      ];
      const result = validateMigrationFiles(files);
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 1);
      assert.equal(result.collisions.length, 1);
      assert.equal(result.collisions[0]![0], "0044");
      assert.ok(result.errors.some((e) => e.includes("COLLISION   0044")));
    });

    test("fails when a 3rd file joins 0040", () => {
      const files = [
        "0040_task_graph.sql",
        "0040_usage_hourly.sql",
        "0040_rogue_migration.sql",
      ];
      const result = validateMigrationFiles(files);
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 1);
      assert.equal(result.collisions.length, 1);
      assert.equal(result.collisions[0]![0], "0040");
      assert.equal(result.excused.length, 0);
    });

    test("fails on unnumbered .sql files", () => {
      const files = [
        "0001_init.sql",
        "setup_schema.sql",
        "patch.sql",
      ];
      const result = validateMigrationFiles(files);
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.unnumbered.sort(), ["patch.sql", "setup_schema.sql"]);
      assert.ok(result.errors.some((e) => e.includes("UNNUMBERED  setup_schema.sql")));
    });

    test("fails on bad width numbers (not 4 digits zero-padded)", () => {
      const files = [
        "1_init.sql",          // 1 digit
        "40_task_graph.sql",   // 2 digits
        "040_task_graph.sql",  // 3 digits
        "00040_task_graph.sql",// 5 digits
      ];
      const result = validateMigrationFiles(files);
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 1);
      assert.equal(result.badWidth.length, 4);
      assert.ok(result.errors.some((e) => e.includes("BAD WIDTH   1_init.sql")));
      assert.ok(result.errors.some((e) => e.includes("BAD WIDTH   40_task_graph.sql")));
      assert.ok(result.errors.some((e) => e.includes("BAD WIDTH   040_task_graph.sql")));
      assert.ok(result.errors.some((e) => e.includes("BAD WIDTH   00040_task_graph.sql")));
    });

    test("fails when empty file list is provided", () => {
      const result = validateMigrationFiles([]);
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 1);
      assert.ok(result.errors.some((e) => e.includes("refusing to pass on empty migration set")));
    });
  });

  describe("validateMigrationDir (filesystem checks)", () => {
    test("passes on live repo db/migrations corpus", () => {
      const result = validateMigrationDir(MIGRATIONS_DIR);
      assert.equal(result.ok, true);
      assert.equal(result.exitCode, 0);
      assert.ok(result.files.length >= 26, `expected >= 26 migrations, found ${result.files.length}`);
      assert.equal(result.unnumbered.length, 0);
      assert.equal(result.badWidth.length, 0);
      assert.equal(result.collisions.length, 0);
      assert.equal(result.excused.length, 1);
      assert.equal(result.excused[0]![0], "0040");
      assert.ok(result.highest !== undefined && result.highest >= "0045");
    });

    test("fails gracefully on non-existent directory", () => {
      const nonExistent = join(tmpdir(), "non_existent_migrations_dir_" + Date.now());
      const result = validateMigrationDir(nonExistent);
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 1);
      assert.ok(result.errors.some((e) => e.includes("cannot read")));
    });

    test("fails on empty directory (0 .sql files)", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "empty-mig-test-"));
      try {
        writeFileSync(join(tempDir, "README.md"), "# Migrations");
        const result = validateMigrationDir(tempDir);
        assert.equal(result.ok, false);
        assert.equal(result.exitCode, 1);
        assert.ok(result.errors.some((e) => e.includes("found 0 .sql files")));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test("correctly parses a temporary directory fixture with mixed files", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "fixture-mig-test-"));
      try {
        writeFileSync(join(tempDir, "0001_init.sql"), "SELECT 1;");
        writeFileSync(join(tempDir, "0002_add_cols.sql"), "SELECT 1;");
        writeFileSync(join(tempDir, "0003_indexes.sql"), "SELECT 1;");
        writeFileSync(join(tempDir, "notes.txt"), "some notes");
        writeFileSync(join(tempDir, ".gitkeep"), "");

        const result = validateMigrationDir(tempDir);
        assert.equal(result.ok, true);
        assert.equal(result.files.length, 3);
        assert.equal(result.highest, "0003");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test("fails on duplicate migration in fixture directory", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "fixture-collision-test-"));
      try {
        writeFileSync(join(tempDir, "0001_init.sql"), "SELECT 1;");
        writeFileSync(join(tempDir, "0002_alpha.sql"), "SELECT 1;");
        writeFileSync(join(tempDir, "0002_beta.sql"), "SELECT 1;");

        const result = validateMigrationDir(tempDir);
        assert.equal(result.ok, false);
        assert.equal(result.collisions.length, 1);
        assert.equal(result.collisions[0]![0], "0002");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("CLI execution integration", () => {
    test("running scripts/checks/check-migration-numbers.ts via tsx exits 0 and prints pass line", () => {
      const scriptPath = fileURLToPath(
        new URL("../../../scripts/checks/check-migration-numbers.ts", import.meta.url),
      );
      const tsxPath = fileURLToPath(
        new URL("../../node_modules/.bin/tsx", import.meta.url),
      );
      const output = execFileSync(
        tsxPath,
        [scriptPath],
        {
          cwd: fileURLToPath(new URL("../../..", import.meta.url)),
          encoding: "utf8",
        },
      );

      assert.match(output, /known debt\s+0040: 0040_task_graph\.sql\s+↔\s+0040_usage_hourly\.sql/);
      assert.match(output, /check-migration-numbers: PASS — \d+ migration\(s\), every number unique/);
    });
  });
});

