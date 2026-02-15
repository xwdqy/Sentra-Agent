const path = require('path');

const repoRoot = __dirname;
const logsDir = path.join(repoRoot, 'logs');

/**
 * PM2 生态配置文件
 * 用于管理 Sentra Agent 主进程
 */

module.exports = {
  apps: [
    {
      name: 'sentra-agent',
      script: './dist/Main.js',
      interpreter: 'node',
      cwd: repoRoot,
      instances: 1,
      exec_mode: 'fork',
      windowsHide: true,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        // Force color output for chalk/colorette under PM2 non-TTY
        FORCE_COLOR: '3',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
      env_production: {
        NODE_ENV: 'production',
        FORCE_COLOR: '3',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
      env_development: {
        NODE_ENV: 'development',
        FORCE_COLOR: '3',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
      error_file: path.join(logsDir, 'pm2-error.log'),
      out_file: path.join(logsDir, 'pm2-out.log'),
      merge_logs: true,
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000,
      kill_timeout: 5000,
      wait_ready: false,
      listen_timeout: 3000,
      instance_var: 'INSTANCE_ID',
      // Do not let PM2 add timestamps; the app already prints time
      // time: false (unset),
      append_env_to_name: false,
    },
    {
      name: 'sentra-emo',
      script: 'run.py',
      interpreter: 'python',
      cwd: path.join(repoRoot, 'sentra-emo'),
      instances: 1,
      exec_mode: 'fork',
      windowsHide: true,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        FORCE_COLOR: '3',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        PYTHONUNBUFFERED: '1',
        UVICORN_RELOAD: '0',
      },
      env_production: {
        FORCE_COLOR: '3',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        PYTHONUNBUFFERED: '1',
        UVICORN_RELOAD: '0',
      },
      env_development: {
        FORCE_COLOR: '3',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        PYTHONUNBUFFERED: '1',
        UVICORN_RELOAD: '1',
      },
      error_file: path.join(logsDir, 'pm2-emo-error.log'),
      out_file: path.join(logsDir, 'pm2-emo-out.log'),
      merge_logs: true,
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000,
      kill_timeout: 5000,
      wait_ready: false,
      listen_timeout: 3000,
      append_env_to_name: false,
    },
    {
      name: 'sentra-napcat',
      script: './dist/src/main.js',
      interpreter: 'node',
      cwd: path.join(repoRoot, 'sentra-adapter', 'napcat'),
      instances: 1,
      exec_mode: 'fork',
      windowsHide: true,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        FORCE_COLOR: '3',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        NAPCAT_MODE: 'reverse',
        ENABLE_TEST_PLUGIN: 'true',
      },
      env_production: {
        NODE_ENV: 'production',
        FORCE_COLOR: '3',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        NAPCAT_MODE: 'reverse',
        ENABLE_TEST_PLUGIN: 'true',
      },
      env_development: {
        NODE_ENV: 'development',
        FORCE_COLOR: '3',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        NAPCAT_MODE: 'reverse',
        ENABLE_TEST_PLUGIN: 'true',
      },
      error_file: path.join(logsDir, 'pm2-napcat-error.log'),
      out_file: path.join(logsDir, 'pm2-napcat-out.log'),
      merge_logs: true,
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000,
      kill_timeout: 5000,
      wait_ready: false,
      listen_timeout: 3000,
      append_env_to_name: false,
    }
  ]
};
