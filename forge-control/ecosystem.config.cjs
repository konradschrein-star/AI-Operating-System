// Load host-only secrets before building the app env.
//
// THIS FILE IS TRACKED IN GIT. No secret may appear below this block.
//
// Two incidents produced this arrangement:
//  - TELEGRAM_BOT_TOKEN came from whatever interactive shell first ran
//    `pm2 start`. Every restart dropped it silently; the bridge died on
//    2026-08-02 and a "weekly review failed" alert sat undelivered for a day.
//  - The postgres passwords were pasted inline here. Committing this file
//    would have published them to GitHub.
//
// Everything secret now lives in a 0600 file on disk, read at pm2 start, so
// restarts are idempotent and `git show` stays boring.
const fs = require('fs');
const SECRETS = '/opt/ai-os/.secrets/forge-control.env';
try {
  for (const line of fs.readFileSync(SECRETS, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 1) continue;
    const k = s.slice(0, i).trim();
    // Never let the file override an explicitly-exported env var.
    if (!process.env[k]) process.env[k] = s.slice(i + 1).trim();
  }
} catch (err) {
  console.error(`[ecosystem] could not read ${SECRETS}: ${err.message}`);
}

/** Required secret. Throwing here beats booting with an empty DSN and failing
 *  later with a confusing "password authentication failed for user". */
function required(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `[ecosystem] ${name} is missing. It must be set in ${SECRETS} ` +
        `(0600) or exported before \`pm2 start\`. Refusing to boot with an ` +
        `empty value.`,
    );
  }
  return v;
}

module.exports = {
  apps: [
    {
      name: 'forge-control',
      script: 'src/index.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: '/opt/forge-ai-os/forge-control',
      env: {
        NODE_ENV: 'production',
        PORT: '7700',
        DATABASE_URL: required('DATABASE_URL'),
        HCP_DATABASE_URL: required('HCP_DATABASE_URL'),
        // The AI OS's OWN database (host postgres :5434), separate from
        // Content Forge. Carries a password, so it comes from the secrets file
        // like the rest. There is deliberately NO fallback in the code: a
        // missing value throws rather than silently reconnecting to
        // content_forge. See db/ai-os-pool.ts.
        AI_OS_DATABASE_URL: required('AI_OS_DATABASE_URL'),
        // v1.6 phase 5: triple extraction routes call claude-pool too.
        // Read from the host env so the key survives cold pm2 starts
        // when launched via `CLAUDE_POOL_API_KEY=... pm2 start ecosystem.config.cjs`.
        CLAUDE_POOL_URL: process.env.CLAUDE_POOL_URL || 'http://127.0.0.1:8092',
        CLAUDE_POOL_API_KEY: process.env.CLAUDE_POOL_API_KEY || '',
        OBSIDIAN_VAULT_DIR: '/opt/obsidian-vault',
        REMINDER_TZ: 'Europe/Berlin',
        UPLOAD_DIR: '/opt/ai-os/uploads',
        // v2.2: cron expressions + reminders read as Berlin wall-clock.
        TZ: 'Europe/Berlin',
        // v2.2: Telegram bridge (VPS Cat). Token from host env at pm2 start —
        // never bake the token into version control.
        TELEGRAM_BOT_TOKEN: required('TELEGRAM_BOT_TOKEN'),
        TELEGRAM_CHAT_ID: '6267562276',
      },
      max_memory_restart: '300M',
      error_file: '/root/.pm2/logs/forge-control-error.log',
      out_file: '/root/.pm2/logs/forge-control-out.log',
    },
    {
      name: 'forge-executor',
      script: 'src/executor.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: '/opt/forge-ai-os/forge-control',
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: required('DATABASE_URL'),
        HCP_DATABASE_URL: required('HCP_DATABASE_URL'),
        // The AI OS's OWN database (host postgres :5434), separate from
        // Content Forge. Carries a password, so it comes from the secrets file
        // like the rest. There is deliberately NO fallback in the code: a
        // missing value throws rather than silently reconnecting to
        // content_forge. See db/ai-os-pool.ts.
        AI_OS_DATABASE_URL: required('AI_OS_DATABASE_URL'),
        CLAUDE_POOL_URL: 'http://127.0.0.1:8092',
        // CLAUDE_POOL_API_KEY is set from the host pm2 env at startup time
        // (see deploy notes) — never bake the key into version control.
        // v2.0: Claude Code engine (default). 'claude-pool' = legacy path.
        EXECUTOR_ENGINE: 'claude-code',
        CC_WORKSPACE: '/opt/ai-os/workspace',
        // v2.6: Opus 5 is the standard. Pinned to the exact id, NOT the bare
        // 'opus' alias — the alias resolves to whatever the CLI calls latest
        // Opus, which silently drifts between CLI releases. Opus 4.8 stays
        // available per-run (metadata.model: 'claude-opus-4-8'); 'haiku' for
        // cheap/frequent heartbeats.
        CC_MODEL: 'claude-opus-5',
        // forge-memory MCP cold-starts via tsx — give stdio servers headroom.
        MCP_TIMEOUT: '30000',
        OBSIDIAN_VAULT_DIR: '/opt/obsidian-vault',
        REMINDER_TZ: 'Europe/Berlin',
        TZ: 'Europe/Berlin',
      },
      max_memory_restart: '300M',
      error_file: '/root/.pm2/logs/forge-executor-error.log',
      out_file: '/root/.pm2/logs/forge-executor-out.log',
    },
  ],
};
