// Drive one debate headless against a running server and print what the strip would show.
// Gates are answered after a short pause (a note for round 0 if --note is given), so a real
// multi-seat run can be recorded without the browser. Usage:
//   node scripts/run-debate.mjs --port 4747 --token <hex> --rounds 1 --note "..." < debate.json
// The token is on the server's startup line; ROUNDTABLE_TOKEN works too.
// stdin: the same JSON body the setup screen posts ({fieldNotes, seats, chairman, options}).
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const PORT = Number(arg('port', 4747));
const NOTE = arg('note', '');
const PAUSE = Number(arg('pause', 3000));
const base = `http://127.0.0.1:${PORT}`;
const SEND = { 'content-type': 'application/json', 'x-roundtable-token': arg('token', process.env.ROUNDTABLE_TOKEN || '') };

const body = JSON.parse(readFileSync(0, 'utf8'));
if (arg('rounds')) body.options = { ...(body.options || {}), critiqueRounds: Number(arg('rounds')) };

const res = await fetch(`${base}/api/debates`, { method: 'POST', headers: SEND, body: JSON.stringify(body) });
const out = await res.json();
if (!res.ok) { console.error('refused:', out.error); process.exit(1); }
const slug = out.slug;
console.log(`debate ${slug}`);

const t0 = Date.now();
const stamp = () => `${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`;
const usage = [];
const calib = [];
const stream = await fetch(`${base}/api/debates/${slug}/events`);
const reader = stream.body.getReader();
const dec = new TextDecoder();
let buf = '';
let done = false;
while (!done) {
  const { value, done: end } = await reader.read();
  if (end) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
    const line = chunk.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const e = JSON.parse(line.slice(6));
    switch (e.type) {
      case 'started': console.log(stamp(), 'seats:', e.seats.map((s) => `${s.label}/${s.lens}${s.model ? '/' + s.model : ''}${s.effort ? '/' + s.effort : ''}`).join(', ')); break;
      case 'attempt': if (e.usage) usage.push(e); console.log(stamp(), `  call ${e.kind} r${e.round} ${e.seat.label || e.seat.vendor}: ${e.usage ? `in ${e.usage.input} cache ${e.usage.cacheRead + e.usage.cacheWrite} out ${e.usage.output}${e.usage.cost != null ? ' $' + e.usage.cost.toFixed(2) : ''}` : 'usage unknown'}`); break;
      case 'reply': console.log(stamp(), `r${e.round} ${e.seat.label} (${e.seat.lens}) -> ${e.stanceKey}${e.question ? ' | Q: ' + e.question : ''}${e.failed ? ' | FAILED ' + e.errors.join('; ') : ''}`); break;
      case 'quota': console.log(stamp(), `quota ${e.vendor}:`, e.quota.windows.map((w) => `${w.label} ${(w.used * 100).toFixed(1)}%`).join(' ')); break;
      case 'calibration': if (e.round != null) { calib.push(e); console.log(stamp(), `calibration ${e.key} round ${e.round}: ${e.tokens} tokens ->`, e.deltas.filter((d) => d.valid).map((d) => `${d.label} +${(d.delta * 100).toFixed(2)}%`).join(' ') || 'no valid delta'); } break;
      case 'gate': {
        console.log(stamp(), `gate ${e.reason} (${e.mode})${e.stop ? ' stop=' + e.stop : ''}${e.questions.length ? ' questions: ' + e.questions.map((q) => q.lens + ': ' + q.question).join(' | ') : ''}`);
        setTimeout(() => fetch(`${base}/api/debates/${slug}/continue`, { method: 'POST', headers: SEND, body: JSON.stringify({ message: e.round === 0 ? NOTE : '' }) }), PAUSE);
        break;
      }
      case 'reopen': console.log(stamp(), 'reopened after a note at a unanimous round 0'); break;
      case 'stopped': console.log(stamp(), `stopped: ${e.reason} after ${e.rounds} rounds`); break;
      case 'verdict': console.log(stamp(), `verdict by ${e.seat?.vendor || 'nobody'}${e.seat?.model ? '/' + e.seat.model : ''}`); break;
      case 'error': console.log(stamp(), 'ERROR', e.message); done = true; break;
      case 'done': done = true; break;
    }
  }
}
const per = {};
for (const e of usage) { const k = e.seat.label ? `${e.seat.label} (${e.seat.lens})` : 'chairman'; const u = (per[k] ??= { in: 0, cache: 0, out: 0, cost: 0 }); u.in += e.usage.input; u.cache += e.usage.cacheRead + e.usage.cacheWrite; u.out += e.usage.output; u.cost += e.usage.cost || 0; }
console.log('\nper seat:'); for (const [k, u] of Object.entries(per)) console.log(`  ${k}: in ${u.in} cache ${u.cache} out ${u.out}${u.cost ? ' $' + u.cost.toFixed(2) : ''}`);
const f = path.join('debates', '_calibration.json');
if (existsSync(f)) console.log('\ncalibration file:', readFileSync(f, 'utf8'));
process.exit(0);
