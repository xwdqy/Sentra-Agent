module.exports = {
  apps: [
    {
      name: 'sentra-config-ui',
      cwd: __dirname,
      script: 'node',
      args: '--import tsx ./scripts/pm2-entry.mjs',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
