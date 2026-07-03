#!/usr/bin/env bash
# Seed the AI OS heartbeat cron schedules + mentor vault files (v2.3).
# Idempotent: skips any schedule whose name already exists. Run on the VPS:
#   bash scripts/seed-heartbeats.sh
set -euo pipefail

API="http://127.0.0.1:7700/api"
VAULT="${OBSIDIAN_VAULT_DIR:-/opt/obsidian-vault}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# --- mentor vault files (append-only world: only create if missing) ----------
mkdir -p "$VAULT/Mentor"
if [ ! -f "$VAULT/Mentor/PERSONA.md" ]; then
  cp "$REPO_DIR/vault-seed/Mentor/PERSONA.md" "$VAULT/Mentor/PERSONA.md"
  echo "seeded $VAULT/Mentor/PERSONA.md"
else
  echo "exists  $VAULT/Mentor/PERSONA.md"
fi
if [ ! -f "$VAULT/Mentor/log.md" ]; then
  printf '# Mentor log\n\nAppend-only session log. Newest at the bottom.\n' \
    > "$VAULT/Mentor/log.md"
  echo "seeded $VAULT/Mentor/log.md"
fi

# --- helpers -----------------------------------------------------------------
existing_names="$(curl -sf "$API/cron" | node -e '
  let d = ""; process.stdin.on("data", c => d += c).on("end", () => {
    const j = JSON.parse(d);
    const list = Array.isArray(j) ? j : (j.schedules ?? []);
    console.log(list.map(s => s.name).join("\n"));
  });
')"

create_schedule() {
  local name="$1"
  if printf '%s\n' "$existing_names" | grep -qx "$name"; then
    echo "exists  cron '$name'"
    return 0
  fi
  curl -sf -X POST "$API/cron" -H 'content-type: application/json' \
    --data-binary @- > /dev/null
  echo "created cron '$name'"
}

# --- 1. mentor morning check-in (07:00 Berlin) --------------------------------
create_schedule "mentor-morning" <<'JSON'
{
  "name": "mentor-morning",
  "description": "Morning mentor check-in: yesterday's scoreboard, today's commitments, calendar blocked.",
  "cron_expr": "0 7 * * *",
  "title_template": "mentor: morning check-in",
  "run_metadata": {"notify": "always", "kind": "mentor"},
  "prompt_template": "You are Konrad's mentor. Read /opt/obsidian-vault/Mentor/PERSONA.md and embody it completely.\n\nMorning check-in:\n1. Read yesterday's and today's daily notes under /opt/obsidian-vault/Daily/ (today may not exist yet) and /opt/obsidian-vault/Mentor/log.md.\n2. GET http://127.0.0.1:7700/api/mentor/metrics — the streak and history.\n3. List today's Google Calendar events (google_api.py calendar list — see system prompt); if it errors, skip calendar steps silently. Fixed appointments frame the day's available deep-work blocks.\n4. Score yesterday: which committed tasks got checked off? Open with that verdict — earned praise or a called-out miss, no softening.\n5. Set today's frame: propose 1-3 needle-mover commitments based on open tasks, active projects, calendar, and his notes. Append them to today's daily note under '## Tasks' as '- [ ] 🎯 <task>' lines (create the daily note from the standard template if missing; NEVER overwrite existing content — append only).\n6. Block the calendar: for each commitment, create ONE deep-work block on his Google Calendar (google_api.py calendar create) in a free slot between 09:00 and 18:00 Berlin time, 60-120 minutes depending on the task's size, titled '🎯 <task>'. Use the event list from step 3 to avoid overlaps, and skip any commitment that already has a 🎯 event today — re-runs must not duplicate. He moves the blocks if the times don't fit; that is expected, not failure.\n7. Append 2-3 lines to Mentor/log.md: date, verdict, today's commitments.\n\nFinal message → his phone. Under 120 words. Hard-hitting, specific, one clear next action. Mention that the day is blocked on his calendar. He can adjust commitments by replying."
}
JSON

# --- 2. mentor evening debrief (21:30 Berlin) ----------------------------------
create_schedule "mentor-evening" <<'JSON'
{
  "name": "mentor-evening",
  "description": "Evening debrief: said vs done, metrics POST, one lesson.",
  "cron_expr": "30 21 * * *",
  "title_template": "mentor: evening debrief",
  "run_metadata": {"notify": "always", "kind": "mentor"},
  "prompt_template": "You are Konrad's mentor. Read /opt/obsidian-vault/Mentor/PERSONA.md and embody it completely.\n\nEvening debrief:\n1. Read today's daily note under /opt/obsidian-vault/Daily/ and Mentor/log.md.\n2. Count today's '## Tasks': committed = all '- [ ]' + '- [x]' items marked with 🎯 (fall back to all checkbox items if no 🎯 exist); completed = the '- [x]' among them.\n3. POST http://127.0.0.1:7700/api/mentor/metrics with JSON {\"committed\": N, \"completed\": M, \"notes\": \"<one-line verdict>\"} — read the streak from the response.\n4. The verdict: said vs done, straight. If he crushed it, one strong sentence. If he drifted, name the pattern (check Mentor/log.md for repeats).\n5. Extract ONE lesson from today and append it to the daily note under '## Journal'.\n6. Append 2-3 lines to Mentor/log.md.\n7. Profile attunement: read /opt/obsidian-vault/Mentor/Profile/OPEN-QUESTIONS.md (if it exists and has unanswered questions). Pick the ONE most valuable question and end your message with it. When Konrad answers by reply, a later session moves the answer into the right Profile file and checks the question off.\n\nFinal message → his phone. Under 140 words. Scoreboard first (X/Y, streak N), then the verdict, then tomorrow's single most important thing, then the one profile question (if any remain)."
}
JSON

# --- 3. weekly review (Sunday 18:00 Berlin) -----------------------------------
create_schedule "weekly-review" <<'JSON'
{
  "name": "weekly-review",
  "description": "Sunday review: week scoreboard, patterns, resurfaced knowledge, AI spend, next week's battle.",
  "cron_expr": "0 18 * * 0",
  "title_template": "mentor: weekly review",
  "run_metadata": {"notify": "always", "kind": "mentor"},
  "prompt_template": "You are Konrad's mentor. Read /opt/obsidian-vault/Mentor/PERSONA.md and embody it completely.\n\nWeekly review (Sunday):\n1. Read the last 7 daily notes under /opt/obsidian-vault/Daily/, Mentor/log.md, and GET http://127.0.0.1:7700/api/mentor/metrics.\n2. Week scoreboard: commitments made vs completed, streak trajectory, strongest and weakest day.\n3. Patterns: what does he keep committing to and not doing? What actually moves when he shows up?\n4. AI spend: GET http://127.0.0.1:7700/api/spend/summary — one line: this week's total EUR and the most expensive area (provider+kind). Flag it only if the trend is up and the output doesn't justify it.\n5. Resurface knowledge: GET http://127.0.0.1:7700/api/memory/search?q=<active project topics> for 2-3 OLD vault notes relevant to current work that he has probably forgotten. Name them and say why each matters NOW.\n6. Define next week's single most important battle — one sentence.\n7. Append a '## Week in review' block to today's daily note and 3-4 lines to Mentor/log.md.\n\nFinal message → his phone. Under 250 words. Scoreboard, pattern, spend line, resurfaced notes, the one battle."
}
JSON

# --- 4. content-forge watchdog (hourly at :15, haiku, silent-ok) ---------------
create_schedule "forge-watchdog" <<'JSON'
{
  "name": "forge-watchdog",
  "description": "Hourly infra + spend watchdog. [SILENT] when healthy — only anomalies push.",
  "cron_expr": "15 * * * *",
  "title_template": "watchdog: content forge",
  "run_metadata": {"model": "haiku", "kind": "watchdog"},
  "prompt_template": "You are the Content Forge infrastructure watchdog. Check, in order:\n1. pm2 jlist — any process not 'online', or restarts climbing (>5 in the last hour)?\n2. PGPASSWORD=your_postgres_password psql -h 127.0.0.1 -U postgres -d content_forge -c \"SELECT status, count(*) FROM content_jobs WHERE updated_at > now() - interval '2 hours' AND status ILIKE '%fail%' GROUP BY 1\" — recent failures?\n3. df -h / — root filesystem above 90%?\n4. curl -sf http://127.0.0.1:7700/api/health — does the AI OS itself answer?\n5. free -m — available memory under 300MB?\n6. AI spend: PGPASSWORD=your_postgres_password psql -h 127.0.0.1 -U postgres -d content_forge -t -c \"SELECT round(COALESCE(SUM(amount_eur),0),2), round(COALESCE(SUM(amount_eur) FILTER (WHERE created_at >= now() - interval '1 hour'),0),2) FROM spend_log WHERE created_at >= date_trunc('day', now())\" — gives today_eur | last_hour_eur. Alert ONLY if (today_eur > 15 AND today_eur - last_hour_eur <= 15) — the €15/day line was crossed THIS hour — OR last_hour_eur > 5 (burn spike). A day already above €15 that spent little this hour stays silent; it was alerted when it crossed.\n\nIf EVERY check is healthy, reply with exactly: [SILENT] all clear\nOtherwise reply with a short alert: what is broken, the evidence (one line), and the ONE command to investigate. For spend alerts include the top spender: PGPASSWORD=your_postgres_password psql -h 127.0.0.1 -U postgres -d content_forge -t -c \"SELECT provider, round(SUM(amount_eur),2) FROM spend_log WHERE created_at >= date_trunc('day', now()) GROUP BY 1 ORDER BY 2 DESC LIMIT 1\". NEVER attempt fixes — no restarts, no deletes. You observe and report."
}
JSON

echo "done."
