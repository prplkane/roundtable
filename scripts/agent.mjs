// JSON CLI; the MCP adapter uses the same client directly.
import { readFile } from 'node:fs/promises';
import { BODY_LIMIT } from '../src/validate.js';
import { HELP, runAgent } from '../src/agent-client.js';
import { clientError } from '../src/local-http.js';

try {
  const args = process.argv.slice(2), command = args.shift();
  if (!command || ['help', '--help', '-h'].includes(command) || args.includes('--help')) { console.log(JSON.stringify(HELP)); }
  else {
    if (!Object.hasOwn(HELP.commands, command)) throw new Error('Unknown agent command. Use agent --help.');
    const flags = {};
    while (args.length) {
      const key = args.shift();
      if (key === '--refresh') { flags.refresh = true; continue; }
      if (!['--port', '--id', '--input', '--seconds', '--after-round'].includes(key) || !args.length || Object.hasOwn(flags, key.slice(2))) throw new Error('Invalid or repeated option. Use agent --help.');
      flags[key.slice(2)] = args.shift();
    }
    async function input(required = true) {
      if (!flags.input) { if (!required) return {}; throw new Error('Supply --input file or --input - for JSON on stdin.'); }
      let text;
      if (flags.input === '-') {
        const chunks = []; let size = 0;
        for await (const chunk of process.stdin) { size += chunk.length; if (size > BODY_LIMIT) throw new Error('Input exceeds 256 KiB.'); chunks.push(chunk); }
        text = Buffer.concat(chunks).toString('utf8');
      } else {
        const bytes = await readFile(flags.input);
        if (bytes.length > BODY_LIMIT) throw new Error('Input exceeds 256 KiB.');
        text = bytes.toString('utf8');
      }
      try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('Input must contain valid JSON.'); }
    }
    const body = ['check', 'start', 'answer', 'hold', 'finish', 'stop', 'resume', 'verdict'].includes(command)
      ? await input(['check', 'start', 'answer', 'hold'].includes(command)) : undefined;
    console.log(JSON.stringify(await runAgent(command, flags, body)));
  }
} catch (error) {
  console.log(JSON.stringify(clientError(error)));
  process.exitCode = 1;
}
