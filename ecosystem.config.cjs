module.exports = {
  apps: [
    {
      name: "cardiq",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: "start --port 3901",
      interpreter: "/opt/homebrew/bin/node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      min_uptime: "10s",
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
      },
    },
    // Daily deal finder (scripts/find-deals.ts). Not a server: it runs once
    // and exits. PM2 starts it at 08:30 every day (cron_restart) and once
    // whenever PM2 itself starts, so a mini that was off catches up on boot;
    // the script skips itself if a good run happened in the last 6 hours.
    // autorestart:false keeps a finished run from being relaunched in a loop.
    {
      name: "cardiq-deals",
      cwd: __dirname,
      script: "scripts/find-deals.ts",
      args: "--apply",
      interpreter: "/opt/homebrew/bin/node",
      interpreter_args: "--import tsx",
      exec_mode: "fork",
      instances: 1,
      autorestart: false,
      cron_restart: "30 8 * * *",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
