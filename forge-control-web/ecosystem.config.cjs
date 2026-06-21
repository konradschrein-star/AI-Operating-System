module.exports = {
  apps: [{
    name: 'forge-control-web',
    script: 'node_modules/next/dist/bin/next',
    args: 'start -p 7701',
    cwd: '/opt/forge-ai-os/forge-control-web',
    env: {
      NODE_ENV: 'production',
      FORGE_CONTROL_URL: 'http://127.0.0.1:7700',
    },
    max_memory_restart: '400M',
    error_file: '/root/.pm2/logs/forge-control-web-error.log',
    out_file: '/root/.pm2/logs/forge-control-web-out.log',
  }]
};
