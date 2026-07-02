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
        DATABASE_URL:
          'postgresql://postgres:your_postgres_password@127.0.0.1:5432/content_forge',
        HCP_DATABASE_URL:
          'postgresql://postgres:your_postgres_password@127.0.0.1:5432/hcp',
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
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
        TELEGRAM_CHAT_ID: '123456789',
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
        DATABASE_URL:
          'postgresql://postgres:your_postgres_password@127.0.0.1:5432/content_forge',
        HCP_DATABASE_URL:
          'postgresql://postgres:your_postgres_password@127.0.0.1:5432/hcp',
        CLAUDE_POOL_URL: 'http://127.0.0.1:8092',
        // CLAUDE_POOL_API_KEY is set from the host pm2 env at startup time
        // (see deploy notes) — never bake the key into version control.
        // v2.0: Claude Code engine (default). 'claude-pool' = legacy path.
        EXECUTOR_ENGINE: 'claude-code',
        CC_WORKSPACE: '/opt/ai-os/workspace',
        // v2.1: Sonnet 5 is the standard; per-run override via metadata.model.
        CC_MODEL: 'sonnet',
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
