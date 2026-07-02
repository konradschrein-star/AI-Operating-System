#!/usr/bin/env bash
# Seed the AI OS heartbeat cron schedules + coach vault files (v2.2).
# Idempotent: skips any schedule whose name already exists. Run on the VPS:
#   bash scripts/seed-heartbeats.sh
set -euo pipefail

API="http://127.0.0.1:7700/api"
VAULT="${OBSIDIAN_VAULT_DIR:-/opt/obsidian-vault}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# --- coach vault files (append-only world: only create if missing) ----------
mkdir -p "$VAULT/Coach"
if [ ! -f "$VAULT/Coach/PERSONA.md" ]; then
  cp "$REPO_DIR/vault-seed/Coach/PERSONA.md" "$VAULT/Coach/PERSONA.md"
  echo "seeded $VAULT/Coach/PERSONA.md"
else
  echo "exists  $VAULT/Coach/PERSONA.md"
fi
if [ ! -f "$VAULT/Coach/log.md" ]; then
  printf '# Coach log\n\nAppend-only session log. Newest at the bottom.\n' \
    > "$VAULT/Coach/log.md"
  echo "seeded $VAULT/Coach/log.md"
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

# --- 1. coach morning check-in (07:00 Berlin) --------------------------------
create_schedule "coach-morning" <<'JSON'
{
  "name": "coach-morning",
  "description": "Morning coach check-in: yesterday's scoreboard, today's commitments.",
  "cron_expr": "0 7 * * *",
  "title_template": "coach: morning check-in",
  "run_metadata": {"notify": "always", "kind": "coach"},
  "prompt_template": "You are Konrad's coach. Read /opt/obsidian-vault/Coach/PERSONA.md and embody it completely.\n\nMorning check-in:\n1. Read yesterday's and today's daily notes under /opt/obsidian-vault/Daily/ (today may not exist yet) and /opt/obsidian-vault/Coach/log.md.\n2. GET http://127.0.0.1:7700/api/coach/metrics — the streak and history.\n3. Score yesterday: which committed tasks got checked off? Open with that verdict — earned praise or a called-out miss, no softening.\n4. Set today's frame: propose 1-3 needle-mover commitments based on open tasks, active projects, and his notes. Append them to today's daily note under '## Tasks' as '- [ ] 🎯 <task>' lines (create the daily note from the standard template if missing; NEVER overwrite existing content — append only).\n5. Append 2-3 lines to Coach/log.md: date, verdict, today's commitments.\n\nFinal message → his phone. Under 120 words. Hard-hitting, specific, one clear next action. He can adjust commitments by replying."
}
JSON

# --- 2. coach evening debrief (21:30 Berlin) ----------------------------------
create_schedule "coach-evening" <<'JSON'
{
  "name": "coach-evening",
  "description": "Evening debrief: said vs done, metrics POST, one lesson.",
  "cron_expr": "30 21 * * *",
  "title_template": "coach: evening debrief",
  "run_metadata": {"notify": "always", "kind": "coach"},
  "prompt_template": "You are Konrad's coach. Read /opt/obsidian-vault/Coach/PERSONA.md and embody it completely.\n\nEvening debrief:\n1. Read today's daily note under /opt/obsidian-vault/Daily/ and Coach/log.md.\n2. Count today's '## Tasks': committed = all '- [ ]' + '- [x]' items marked with 🎯 (fall back to all checkbox items if no 🎯 exist); completed = the '- [x]' among them.\n3. POST http://127.0.0.1:7700/api/coach/metrics with JSON {\"committed\": N, \"completed\": M, \"notes\": \"<one-line verdict>\"} — read the streak from the response.\n4. The verdict: said vs done, straight. If he crushed it, one strong sentence. If he drifted, name the pattern (check Coach/log.md for repeats).\n5. Extract ONE lesson from today and append it to the daily note under '## Journal'.\n6. Append 2-3 lines to Coach/log.md.\n\nFinal message → his phone. Under 120 words. Scoreboard first (X/Y, streak N), then the verdict, then tomorrow's single most important thing."
}
JSON

# --- 3. weekly review (Sunday 18:00 Berlin) -----------------------------------
create_schedule "weekly-review" <<'JSON'
{
  "name": "weekly-review",
  "description": "Sunday review: week scoreboard, patterns, resurfaced knowledge, next week's battle.",
  "cron_expr": "0 18 * * 0",
  "title_template": "coach: weekly review",
  "run_metadata": {"notify": "always", "kind": "coach"},
  "prompt_template": "You are Konrad's coach. Read /opt/obsidian-vault/Coach/PERSONA.md and embody it completely.\n\nWeekly review (Sunday):\n1. Read the last 7 daily notes under /opt/obsidian-vault/Daily/, Coach/log.md, and GET http://127.0.0.1:7700/api/coach/metrics.\n2. Week scoreboard: commitments made vs completed, streak trajectory, strongest and weakest day.\n3. Patterns: what does he keep committing to and not doing? What actually moves when he shows up?\n4. Resurface knowledge: GET http://127.0.0.1:7700/api/memory/search?q=<active project topics> for 2-3 OLD vault notes relevant to current work that he has probably forgotten. Name them and say why each matters NOW.\n5. Define next week's single most important battle — one sentence.\n6. Append a '## Week in review' block to today's daily note and 3-4 lines to Coach/log.md.\n\nFinal message → his phone. Under 250 words. Scoreboard, pattern, resurfaced notes, the one battle."
}
JSON

# --- 4. content-forge watchdog (hourly at :15, haiku, silent-ok) ---------------
create_schedule "forge-watchdog" <<'JSON'
{
  "name": "forge-watchdog",
  "description": "Hourly infra watchdog. [SILENT] when healthy — only anomalies push.",
  "cron_expr": "15 * * * *",
  "title_template": "watchdog: content forge",
  "run_metadata": {"model": "haiku", "kind": "watchdog"},
  "prompt_template": "You are the Content Forge infrastructure watchdog. Check, in order:\n1. pm2 jlist — any process not 'online', or restarts climbing (>5 in the last hour)?\n2. psql -U postgres -d content_forge -c \"SELECT status, count(*) FROM content_jobs WHERE updated_at > now() - interval '2 hours' AND status ILIKE '%fail%' GROUP BY 1\" — recent failures?\n3. df -h / — root filesystem above 90%?\n4. curl -sf http://127.0.0.1:7700/api/health — does the AI OS itself answer?\n5. free -m — available memory under 300MB?\n\nIf EVERY check is healthy, reply with exactly: [SILENT] all clear\nOtherwise reply with a short alert: what is broken, the evidence (one line), and the ONE command to investigate. NEVER attempt fixes — no restarts, no deletes. You observe and report."
}
JSON

echo "done."
