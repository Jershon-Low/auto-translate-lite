module.exports = {
  apps: [
    {
      name: 'auto-translate-server',
      cwd: './server',
      script: 'dist/index.js',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'auto-translate-web',
      cwd: './web',
      script: 'node_modules/.bin/next',
      args: 'start',
      env: { NODE_ENV: 'production' },
    },
  ],
};
