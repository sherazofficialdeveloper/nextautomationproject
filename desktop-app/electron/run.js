'use strict';

// Cross-platform launcher for Electron.
// Ensures ELECTRON_RUN_AS_NODE is stripped so Electron always boots in application mode
// even when launched from IDE/VSCode terminals.

const proc = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = proc.spawn(electron, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

child.on('close', (code) => {
  process.exit(code || 0);
});

