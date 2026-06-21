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
          'postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge',
        HCP_DATABASE_URL:
          'postgresql://postgres:content_forge_prod@127.0.0.1:5432/hcp',
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
          'postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge',
        HCP_DATABASE_URL:
          'postgresql://postgres:content_forge_prod@127.0.0.1:5432/hcp',
        CLAUDE_POOL_URL: 'http://127.0.0.1:8092',
        // CLAUDE_POOL_API_KEY is set from the host pm2 env at startup time
        // (see deploy notes) — never bake the key into version control.
      },
      max_memory_restart: '300M',
      error_file: '/root/.pm2/logs/forge-executor-error.log',
      out_file: '/root/.pm2/logs/forge-executor-out.log',
    },
  ],
};
