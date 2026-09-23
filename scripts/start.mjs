// Launches the built app with Electron, forwarding CLI flags (e.g. --mock=warning --screenshot=out.png).
// ELECTRON_RUN_AS_NODE is removed first: tools like VS Code / Claude Code set it for child processes,
// which would make Electron start as plain Node (and `app` would be undefined).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [root, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
