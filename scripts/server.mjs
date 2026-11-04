import { inspectServer, ensureServer, stopServer } from '../src/local-server.js';
import { clientError } from '../src/local-http.js';
import { LIMITS } from '../src/validate.js';

const args = process.argv.slice(2), command = args.shift();
if (!command || ['help', '--help', '-h'].includes(command) || args.includes('--help')) {
  console.log('roundtable server status|start|stop|restart [--port N] [--fake]\nManage the hidden local board. Stop/restart refuses active reviews and never cancels them. Use the same data directory and mode as the running board.');
} else {
  try {
    if (!['status', 'start', 'stop', 'restart'].includes(command)) throw new Error('Unknown server command. Use roundtable server --help.');
    const config = { fake: false };
    while (args.length) {
      const arg = args.shift();
      if (arg === '--fake' && !config.fake) config.fake = true;
      else if (arg === '--port' && args.length && config.port == null) config.port = Number(args.shift());
      else throw new Error('Invalid or repeated server option. Use roundtable server --help.');
    }
    config.port ??= config.fake ? 4748 : 4747;
    if (!Number.isInteger(config.port) || config.port < LIMITS.port[0] || config.port > LIMITS.port[1]) throw new Error('Invalid loopback port.');
    let result;
    if (command === 'status') result = { ok: true, server: await inspectServer(config, { allowOlder: true }) };
    else {
      if (['stop', 'restart'].includes(command)) result = await stopServer(config);
      if (['start', 'restart'].includes(command)) result = { ok: true, server: await ensureServer(config) };
    }
    console.log(JSON.stringify(result));
  } catch (e) { console.log(JSON.stringify(clientError(e))); process.exitCode = 1; }
}
