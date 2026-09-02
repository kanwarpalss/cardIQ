module.exports = {
  apps: [
    {
      name: "cardiq",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: "start --port 3128",
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
  ],
};
