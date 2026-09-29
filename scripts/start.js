'use strict';
// `npm start`: launch Electron on this app. Clears ELECTRON_RUN_AS_NODE,
// which editors built on Electron (VS Code and its extensions) leak into
// child processes and which would make Electron run as plain Node.

const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron'); // resolves to the binary path in Node

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], { env, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
