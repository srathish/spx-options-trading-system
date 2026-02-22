module.exports = {
  apps: [
    {
      name: 'openclaw',
      script: 'src/index.js',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'openclaw-dashboard',
      script: 'node_modules/.bin/next',
      args: 'start',
      cwd: __dirname + '/dashboard',
      watch: false,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
