module.exports = {
  apps: [
    {
      name: "cafemart-backend",
      script: "./dist/server.js",
      instances: process.env.PM2_INSTANCES || "max",
      exec_mode: "cluster",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      kill_timeout: 12000,
      listen_timeout: 10000,
      wait_ready: true,
      shutdown_with_message: true,
      env: {
        NODE_ENV: "development",
        CLUSTER_MODE: "true",
      },
      env_production: {
        NODE_ENV: "production",
        CLUSTER_MODE: "true",
      },
    },
  ],
};
