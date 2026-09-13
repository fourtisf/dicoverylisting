// PM2 process config for the Dexvra bot. Run from the bot/ directory:
//   pm2 start ecosystem.config.js && pm2 save
// Reads secrets from bot/.env (loaded by main.js via dotenv) — do NOT put
// secrets here.
module.exports = {
  apps: [
    {
      name: "dexvra-bot",
      script: "main.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      // Banner rendering (napi-rs canvas + ffmpeg) spikes RAM transiently; 400M
      // was too low and forced mid-listing restarts. min_uptime + a higher
      // max_restarts stop PM2 from permanently giving up after a few blips.
      max_restarts: 50,
      min_uptime: "30s",
      restart_delay: 5000,
      // Give the bot time to close its Telegram long-poll cleanly on SIGTERM.
      // Killed too fast, the old getUpdates lingers ~50s and the fresh process
      // gets 409 Conflict — the "bot doesn't answer for a minute after restart".
      kill_timeout: 6000,
      watch: false,
      max_memory_restart: "1G",
      env: { NODE_ENV: "production" },
    },
    {
      name: "dexvra-adminbot",
      script: "adminbot.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 50,
      min_uptime: "30s",
      restart_delay: 5000,
      kill_timeout: 6000,
      watch: false,
      max_memory_restart: "768M",
      env: { NODE_ENV: "production" },
    },
  ],
};
