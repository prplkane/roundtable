#!/usr/bin/env node
// The `roundtable` command (package.json "bin"). One entry point, the same scripts as
// `npm run`: it starts the right one with the arguments passed through.
//
//   roundtable                 the board on http://localhost:4747, opened in your browser
//   roundtable fake            the board with scripted seats, nothing spent (port 4748)
//   roundtable doctor [--live] what this machine can seat
//   roundtable export <slug> <dir>
//   roundtable debate [...]    one debate headless against a running server (see the script)
//   --port <n> --no-open       for the two board commands
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = {
  start: ['src/server.js'], fake: ['src/server.js', '--fake'], doctor: ['src/doctor.js'],
  export: ['scripts/export.mjs'], debate: ['scripts/run-debate.mjs'], agent: ['scripts/agent.mjs'],
};

const args = process.argv.slice(2);
const USAGE = ['roundtable [--port <n>] [--no-open]   the board, opened in your browser', 'roundtable fake [--port <n>]          the board with scripted seats, nothing spent',
  'roundtable doctor [--live]            what this machine can seat', 'roundtable export <slug> <dir>        write a decision record into a codebase',
  'roundtable debate [--token <hex>] ... one debate headless, body on stdin',
  'roundtable agent --help              JSON commands for agents; no GUI needed'].join('\n');
// help first, wherever it is on the line: a bare `--help` must never start the real server
if (args[0] !== 'agent' && args.some((a) => a === 'help' || a === '--help' || a === '-h')) { console.log(USAGE); process.exit(0); }
const cmd = args[0] && !args[0].startsWith('-') ? args.shift() : 'start';
if (!SCRIPTS[cmd]) { console.error(`unknown command: ${cmd}\n\n${USAGE}`); process.exit(2); }
const env = { ...process.env };
const port = args.indexOf('--port');
if (port >= 0 && ['start', 'fake'].includes(cmd)) { env.PORT = args[port + 1]; args.splice(port, 2); }
const [script, ...fixed] = SCRIPTS[cmd]; // only the script is a path; the rest are the server's own flags
const child = spawn(process.execPath, [path.join(ROOT, script), ...fixed, ...args], { stdio: 'inherit', env, windowsHide: true });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
// A signal to this process goes to the child too; this process ends when the child does. (A
// handler that only waited swallowed SIGTERM on Linux, and `kill` could not stop it.)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig); } catch {} });
