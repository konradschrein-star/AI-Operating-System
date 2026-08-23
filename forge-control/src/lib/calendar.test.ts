/**
 * Tests for Google Calendar integration wrapper.
 *
 * Run: cd forge-control && npm test   (tsx --test)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listCalendarEvents,
  createCalendarEvent,
  DEFAULT_GOOGLE_API_SCRIPT,
  type CalendarEvent,
} from "./calendar.ts";

describe("calendar argument validation", () => {
  test("listCalendarEvents rejects non-positive or non-integer max", async () => {
    await assert.rejects(
      async () => listCalendarEvents({ max: 0 }),
      /max must be a positive integer/,
    );
    await assert.rejects(
      async () => listCalendarEvents({ max: -5 }),
      /max must be a positive integer/,
    );
    await assert.rejects(
      async () => listCalendarEvents({ max: 2.5 }),
      /max must be a positive integer/,
    );
  });

  test("createCalendarEvent rejects empty summary", async () => {
    await assert.rejects(
      async () =>
        createCalendarEvent({
          summary: "",
          start: "2026-08-23T10:00:00Z",
          end: "2026-08-23T11:00:00Z",
        }),
      /summary is required and must be non-empty/,
    );
    await assert.rejects(
      async () =>
        createCalendarEvent({
          summary: "   ",
          start: "2026-08-23T10:00:00Z",
          end: "2026-08-23T11:00:00Z",
        }),
      /summary is required and must be non-empty/,
    );
  });

  test("createCalendarEvent rejects missing start or end", async () => {
    await assert.rejects(
      // @ts-expect-error test invalid args
      async () => createCalendarEvent({ summary: "Test", end: "2026-08-23T11:00:00Z" }),
      /start is required/,
    );
    await assert.rejects(
      // @ts-expect-error test invalid args
      async () => createCalendarEvent({ summary: "Test", start: "2026-08-23T10:00:00Z" }),
      /end is required/,
    );
  });
});

describe("calendar CLI interaction with mock python script", () => {
  test("listCalendarEvents parses JSON event list correctly", async () => {
    const mockEvents: CalendarEvent[] = [
      {
        id: "evt-123",
        summary: "Focus Block",
        start: "2026-08-23T09:00:00+02:00",
        end: "2026-08-23T11:00:00+02:00",
        location: "Desk",
        description: "Deep work on AI OS",
        status: "confirmed",
        htmlLink: "https://calendar.google.com/event?id=evt-123",
      },
    ];

    const scriptFile = join(tmpdir(), `mock-gcal-${Date.now()}.py`);
    writeFileSync(
      scriptFile,
      `import sys, json
if "list" in sys.argv:
    print(json.dumps(${JSON.stringify(mockEvents)}))
`,
    );

    try {
      const res = await listCalendarEvents(
        { start: "2026-08-23T00:00:00Z", end: "2026-08-23T23:59:59Z", max: 10 },
        { scriptPath: scriptFile },
      );
      assert.deepEqual(res, mockEvents);
      assert.equal(res.length, 1);
      assert.equal(res[0]?.summary, "Focus Block");
    } finally {
      try {
        unlinkSync(scriptFile);
      } catch {}
    }
  });

  test("createCalendarEvent passes arguments and parses response", async () => {
    const mockResponse = {
      status: "created",
      id: "new-evt-456",
      summary: "Team Sync",
      htmlLink: "https://calendar.google.com/event?id=new-evt-456",
    };

    const scriptFile = join(tmpdir(), `mock-gcal-create-${Date.now()}.py`);
    writeFileSync(
      scriptFile,
      `import sys, json
if "create" in sys.argv:
    print(json.dumps(${JSON.stringify(mockResponse)}))
`,
    );

    try {
      const res = await createCalendarEvent(
        {
          summary: "Team Sync",
          start: "2026-08-23T14:00:00+02:00",
          end: "2026-08-23T15:00:00+02:00",
          location: "Room 1",
          description: "Weekly sync",
        },
        { scriptPath: scriptFile },
      );
      assert.deepEqual(res, mockResponse);
      assert.equal(res.id, "new-evt-456");
      assert.equal(res.status, "created");
    } finally {
      try {
        unlinkSync(scriptFile);
      } catch {}
    }
  });

  test("handles CLI failures and bad output cleanly", async () => {
    const scriptFile = join(tmpdir(), `mock-gcal-err-${Date.now()}.py`);
    writeFileSync(
      scriptFile,
      `import sys
sys.stderr.write("Token expired or network down\\n")
sys.exit(1)
`,
    );

    try {
      await assert.rejects(
        async () => listCalendarEvents({}, { scriptPath: scriptFile }),
        /Google Calendar CLI error \(list\): Token expired or network down/,
      );
    } finally {
      try {
        unlinkSync(scriptFile);
      } catch {}
    }
  });
});
