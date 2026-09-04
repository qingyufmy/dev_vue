const common = {
  cwd: __dirname,
  interpreter: 'node',
  exec_mode: 'fork',
  instances: 1,
  watch: false,
  autorestart: true,
  restart_delay: 2000,
  kill_timeout: 15000,
  listen_timeout: 10000,
  env: {
    NODE_ENV: 'production',
    AURUM_V4_RUNTIME_ENABLED: 'true',
  },
}

module.exports = {
  apps: [
    {
      ...common,
      name: 'aurum-v4-api',
      script: 'server/dist-v4/entrypoints/api-v4.js',
      max_memory_restart: '512M',
    },
    {
      ...common,
      name: 'aurum-v4-browser-realtime',
      script: 'server/dist-v4/entrypoints/browser-realtime.js',
      max_memory_restart: '384M',
    },
    {
      ...common,
      name: 'aurum-v4-bridge-gateway',
      script: 'server/dist-v4/entrypoints/bridge-gateway.js',
      max_memory_restart: '384M',
    },
    {
      ...common,
      name: 'aurum-v4-outbox-dispatcher',
      script: 'server/dist-v4/entrypoints/outbox-dispatcher.js',
      max_memory_restart: '256M',
    },
    {
      ...common,
      name: 'aurum-v4-worker-execution',
      script: 'server/dist-v4/entrypoints/worker-execution.js',
      max_memory_restart: '384M',
    },
  ],
}
