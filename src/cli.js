#!/usr/bin/env node
// The `roundtable` command (package.json "bin"). One entry point, the same scripts as
// `npm run`: it starts the right one with the arguments passed through.
//
//   roundtable                 the board on http://localhost:4747, opened in your browser
//   roundtable fake            the board with scripted seats, nothing spent (port 4748)
//   roundtable doctor [--live] what this machine can seat
//   roundtable export <slug> <dir>
//   roundtable debate [...]    one debate headless against a running server (see the script)
//   --port <n> --no-open       for the two board commands; any other option there is refused
//   roundtable --version       the installed version
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalBanner } from './terminal.js';
import { VERSION } from './version.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = {
  start: ['src/server.js'], fake: ['src/server.js', '--fake'], doctor: ['src/doctor.js'],
  export: ['scripts/export.mjs'], debate: ['scripts/run-debate.mjs'], agent: ['scripts/agent.mjs'],
  mcp: ['scripts/mcp.mjs'], setup: ['scripts/setup.mjs'], server: ['scripts/server.mjs'],
};

const args = process.argv.slice(2);
const USAGE = ['roundtable [--port <n>] [--no-open]   the board, opened in your browser', 'roundtable fake [--port <n>]          the board with scripted seats, nothing spent',
  'roundtable doctor [--live]            what this machine can seat', 'roundtable export <slug> <dir>        write a decision record into a codebase',
  'roundtable debate [--token <hex>] ... one debate headless, body on stdin',
  'roundtable agent --help              JSON commands for agents; no GUI needed',
  'roundtable setup --client codex      connect an assistant across projects (also claude, agy, all)',
  'roundtable setup --help              inspect, update or remove that connection',
  'roundtable server --help             check, start, stop or restart the hidden board',
  'roundtable mcp                       MCP tools over stdio; starts the local server as needed',
  'roundtable --version                 the installed version'].join('\n');
// help first, wherever it is on the line: a bare `--help` must never start the real server
if (!['agent', 'setup', 'mcp', 'server'].includes(args[0]) && args.some((a) => a === 'help' || a === '--help' || a === '-h')) { process.stdout.write(terminalBanner()); console.log(USAGE); process.exit(0); }
// the version and nothing else, asked for first on the line (a later -v belongs to a subcommand)
if (['--version', '-v', '-V', 'version'].includes(args[0])) { console.log(VERSION); process.exit(0); }
const refuse = (why) => { console.error(`${why}\n\n${USAGE}`); process.exit(2); };
const cmd = args[0] && !args[0].startsWith('-') ? args.shift() : 'start';
if (!SCRIPTS[cmd]) refuse(`unknown command: ${cmd}`);
// The board commands take these options and no others. An unrecognised one used to fall through
// and start the board (a mistyped --port opened the live server on the default port), so it is
// refused here, before anything starts. The other commands check their own arguments.
if (['start', 'fake'].includes(cmd)) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') {
      const n = /^\d{1,5}$/.test(args[i + 1] ?? '') ? Number(args[i + 1]) : 0;
      if (n < 1 || n > 65535) refuse('--port needs a number from 1 to 65535');
      i++;
    } else if (!['--no-open', '--fake', '--fake-consensus'].includes(args[i])) refuse(`unknown option: ${args[i]}`);
  }
}
const env = { ...process.env };
const port = args.indexOf('--port');
if (port >= 0 && ['start', 'fake'].includes(cmd)) { env.PORT = args[port + 1]; args.splice(port, 2); }
const [script, ...fixed] = SCRIPTS[cmd]; // only the script is a path; the rest are the server's own flags
const child = spawn(process.execPath, [path.join(ROOT, script), ...fixed, ...args], { stdio: 'inherit', env, windowsHide: true });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
// A signal to this process goes to the child too; this process ends when the child does. (A
// handler that only waited swallowed SIGTERM on Linux, and `kill` could not stop it.)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig); } catch {} });
