#!/usr/bin/env bash
# =============================================================================
# AI OS v2.1 — arms & hands installer (run ON the VPS as root)
#
#   bash scripts/install-skills-mcp.sh
#
# Idempotent. Installs/refreshes:
#   1. Skill packs (cloned to /opt/ai-os/skills-src, symlinked into
#      /root/.claude/skills so EVERY Claude Code instance sees them)
#   2. Hermes skills (symlinked out of the hermes-agent docker volume)
#   3. Subagent definitions (repo agents/*.md → /root/.claude/agents)
#   4. MCP servers (user scope): context7 w/ API key, official GitHub MCP
#      (docker, token minted from gh CLI), chrome-devtools (+ Chrome for
#      Testing), shadcn registry, forge-memory
#   5. docker mcp CLI plugin (gateway available, not auto-registered)
#
# Env:
#   CONTEXT7_API_KEY   required for the context7 upgrade (else keeps keyless)
# =============================================================================
set -uo pipefail

SRC=/opt/ai-os/skills-src
DEST=/root/.claude/skills
AGENTS_DEST=/root/.claude/agents
HERMES_SKILLS=/var/lib/docker/volumes/hermes-workspace_hermes-agent-data/_data/skills
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$SRC" "$DEST" "$AGENTS_DEST" /opt/ai-os/uploads /opt/ai-os/browsers

say()  { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m   ok: %s\033[0m\n' "$*"; }
warn() { printf '\033[0;33m   warn: %s\033[0m\n' "$*"; }

clone_or_pull() { # url dir
  local url="$1" dir="$2"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" pull --ff-only -q && ok "updated $(basename "$dir")" || warn "pull failed $(basename "$dir") (keeping existing)"
  else
    git clone -q --depth 1 "$url" "$dir" && ok "cloned $(basename "$dir")" || warn "clone failed: $url"
  fi
}

# Symlink every directory containing a SKILL.md into DEST. Collision-safe:
# if the name is taken by a different target, prefix with the pack name.
link_skills() { # repo_dir prefix
  local repo_dir="$1" prefix="$2" count=0
  while IFS= read -r f; do
    local d name target
    d="$(dirname "$f")"
    name="$(basename "$d")"
    target="$DEST/$name"
    if [ -e "$target" ] && [ "$(readlink -f "$target" 2>/dev/null)" != "$(readlink -f "$d")" ]; then
      target="$DEST/${prefix}--${name}"
    fi
    ln -sfn "$d" "$target" && count=$((count+1))
  done < <(find "$repo_dir" -maxdepth 6 -name SKILL.md -not -path '*/node_modules/*' -not -path '*/.git/*')
  ok "$prefix: linked $count skill dir(s)"
}

# -----------------------------------------------------------------------------
say "1/5 Skill packs"
clone_or_pull https://github.com/obra/superpowers.git              "$SRC/superpowers"
clone_or_pull https://github.com/leonxlnx/taste-skill.git          "$SRC/taste-skill"
clone_or_pull https://github.com/lackeyjb/playwright-skill.git     "$SRC/playwright-skill"
clone_or_pull https://github.com/remotion-dev/skills.git           "$SRC/remotion-skills"
clone_or_pull https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git "$SRC/ui-ux-pro-max"
clone_or_pull https://github.com/adam-s/agent-tuning.git           "$SRC/agent-tuning"
clone_or_pull https://github.com/adam-s/intercept.git              "$SRC/intercept"
clone_or_pull https://github.com/gsd-build/get-shit-done.git       "$SRC/get-shit-done"

link_skills "$SRC/superpowers"      superpowers
link_skills "$SRC/taste-skill"      taste
link_skills "$SRC/playwright-skill" playwright-skill
link_skills "$SRC/remotion-skills"  remotion
link_skills "$SRC/ui-ux-pro-max"    uiux
link_skills "$SRC/agent-tuning"     agent-tuning
# intercept: ONLY the instruction-tuning skill, not the whole app repo
if [ -d "$SRC/intercept/.claude/skills/instruction-tuning" ]; then
  ln -sfn "$SRC/intercept/.claude/skills/instruction-tuning" "$DEST/instruction-tuning"
  ok "instruction-tuning linked"
else
  link_skills "$SRC/intercept/.claude/skills" intercept 2>/dev/null || warn "intercept skills dir not found"
fi
link_skills "$SRC/get-shit-done" gsd
# GSD also ships commands/agents — merge them in (never overwrite ours)
for sub in commands agents; do
  if [ -d "$SRC/get-shit-done/.claude/$sub" ]; then
    mkdir -p "/root/.claude/$sub"
    cp -rn "$SRC/get-shit-done/.claude/$sub/." "/root/.claude/$sub/" 2>/dev/null
    ok "gsd $sub merged"
  fi
done

# -----------------------------------------------------------------------------
say "2/5 Hermes skills → global"
if [ -d "$HERMES_SKILLS" ]; then
  count=0
  while IFS= read -r f; do
    d="$(dirname "$f")"
    rel="${d#"$HERMES_SKILLS"/}"
    flat="hermes--$(echo "$rel" | tr '/' '-')"
    ln -sfn "$d" "$DEST/$flat" && count=$((count+1))
  done < <(find "$HERMES_SKILLS" -maxdepth 4 -name SKILL.md -not -path '*/node_modules/*')
  ok "hermes: linked $count skill(s) globally"
else
  warn "hermes skills dir not found at $HERMES_SKILLS"
fi

# -----------------------------------------------------------------------------
say "3/5 Subagents (architect/planner/builder/reviewer/scout)"
cp -f "$REPO_DIR/agents/"*.md "$AGENTS_DEST/" && ok "agents installed: $(ls "$AGENTS_DEST" | tr '\n' ' ')"

# -----------------------------------------------------------------------------
say "4/5 MCP servers (user scope)"

# context7 — upgrade to keyed access when CONTEXT7_API_KEY is provided
if [ -n "${CONTEXT7_API_KEY:-}" ]; then
  claude mcp remove -s user context7 >/dev/null 2>&1 || true
  claude mcp add -s user context7 -- npx -y @upstash/context7-mcp --api-key "$CONTEXT7_API_KEY" \
    && ok "context7 (keyed)" || warn "context7 add failed"
else
  warn "CONTEXT7_API_KEY not set — leaving existing context7 as-is"
fi

# GitHub official MCP (replaces archived @modelcontextprotocol/server-github)
GH_TOKEN="$(gh auth token 2>/dev/null || true)"
if [ -n "$GH_TOKEN" ]; then
  docker pull -q ghcr.io/github/github-mcp-server >/dev/null 2>&1 || warn "docker pull github-mcp-server failed (will pull on first use)"
  claude mcp remove -s user github >/dev/null 2>&1 || true
  claude mcp add-json -s user github "{\"command\":\"docker\",\"args\":[\"run\",\"-i\",\"--rm\",\"-e\",\"GITHUB_PERSONAL_ACCESS_TOKEN\",\"ghcr.io/github/github-mcp-server\"],\"env\":{\"GITHUB_PERSONAL_ACCESS_TOKEN\":\"$GH_TOKEN\"}}" \
    && ok "github (official, via gh token)" || warn "github mcp add failed"
else
  warn "gh not authenticated — kept old github MCP"
fi

# chrome-devtools-mcp — needs a Chrome binary
CHROME_BIN="$(find /opt/ai-os/browsers -type f -name chrome 2>/dev/null | head -1)"
if [ -z "$CHROME_BIN" ]; then
  npx -y @puppeteer/browsers install chrome@stable --path /opt/ai-os/browsers >/dev/null 2>&1 \
    && CHROME_BIN="$(find /opt/ai-os/browsers -type f -name chrome 2>/dev/null | head -1)" \
    || warn "chrome install failed"
fi
if [ -n "$CHROME_BIN" ]; then
  claude mcp remove -s user chrome-devtools >/dev/null 2>&1 || true
  claude mcp add-json -s user chrome-devtools "{\"command\":\"npx\",\"args\":[\"-y\",\"chrome-devtools-mcp@latest\",\"--headless=true\",\"--isolated=true\",\"--executablePath=$CHROME_BIN\"]}" \
    && ok "chrome-devtools ($CHROME_BIN)" || warn "chrome-devtools add failed"
else
  warn "no Chrome binary — chrome-devtools MCP skipped"
fi

# shadcn registry MCP
claude mcp remove -s user shadcn >/dev/null 2>&1 || true
claude mcp add-json -s user shadcn '{"command":"npx","args":["-y","shadcn@latest","mcp"]}' \
  && ok "shadcn" || warn "shadcn add failed"

# forge-memory (our own MCP — re-wire if it fell out of config)
if ! claude mcp get forge-memory >/dev/null 2>&1; then
  if [ -f "$REPO_DIR/scripts/add-mcp-forge-memory.sh" ]; then
    bash "$REPO_DIR/scripts/add-mcp-forge-memory.sh" && ok "forge-memory re-wired" || warn "forge-memory wire failed"
  fi
else
  ok "forge-memory already wired"
fi

# -----------------------------------------------------------------------------
say "5/5 docker mcp CLI plugin (gateway, optional)"
if ! docker mcp version >/dev/null 2>&1; then
  PLUGIN_URL="$(curl -fsSL https://api.github.com/repos/docker/mcp-gateway/releases/latest 2>/dev/null | grep -o 'https://[^\"]*linux-amd64[^\"]*' | head -1)"
  if [ -n "$PLUGIN_URL" ]; then
    mkdir -p /root/.docker/cli-plugins
    case "$PLUGIN_URL" in
      *.tar.gz) curl -fsSL "$PLUGIN_URL" | tar -xz -C /tmp && find /tmp -maxdepth 2 -name 'docker-mcp*' -type f -newer /opt/ai-os -exec mv {} /root/.docker/cli-plugins/docker-mcp \; ;;
      *) curl -fsSL "$PLUGIN_URL" -o /root/.docker/cli-plugins/docker-mcp ;;
    esac
    chmod +x /root/.docker/cli-plugins/docker-mcp 2>/dev/null
    docker mcp version >/dev/null 2>&1 && ok "docker mcp plugin installed" || warn "docker mcp plugin install incomplete — gateway optional, skipping"
  else
    warn "could not resolve docker/mcp-gateway release — skipping (optional)"
  fi
else
  ok "docker mcp plugin already present"
fi

# -----------------------------------------------------------------------------
say "Summary"
echo "   skills in $DEST: $(ls "$DEST" | wc -l)"
echo "   agents: $(ls "$AGENTS_DEST" | wc -l)"
claude mcp list 2>&1 | sed 's/^/   /'
