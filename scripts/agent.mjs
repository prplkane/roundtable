// A compact JSON client for agents. Reading or checking never starts a provider call.
import { readFile } from 'node:fs/promises';
import { BODY_LIMIT } from '../src/validate.js';

const HELP = {
  usage: 'roundtable agent <status|check|start|wait|answer|finish|stop|resume|verdict> [--port 4747] [--id review-id] [--input file|-] [--seconds 25] [--refresh]',
  commands: {
    status: 'Without --id: cached provider setup. With --id: current step, questions, latest positions and verdict. --refresh refreshes free CLI status checks.',
    check: 'Validate --input and estimate calls/tokens without creating a review.',
    start: 'Start the review in --input. Uses the selected providers. Returns its id immediately.',
    wait: 'Wait up to --seconds (1–30) for a question or completion. Returns one state object, not an event log.',
    answer: 'Send --input {round, answers:[{id:"q1",text:"..."}], message:"optional note"}, labelled as an agent note. Read the current state first; never invent a missing answer.',
    stop: 'Cancel all in-flight calls, including the chairman; keep completed replies. A verdict runs later only if explicitly requested.',
    finish: 'End discussion and write the verdict from collected replies. Available after one complete round has a usable reply; may make a chairman call.',
    resume: 'Resume an interrupted review. May make provider calls.',
    verdict: 'Request a missing or failed verdict from saved replies. May make a provider call.',
  },
  setup: 'Use the server already running on --port when status answers; start one only if none is up: roundtable --no-open (or roundtable fake --no-open for a free test). This client reads its launch token locally; it never prints or stores the token.',
  input: 'check/start accept the same {fieldNotes,seats,chairman,options} JSON as the board. Check available providers first. Every result with an id carries board, a link where a person can watch the review in a browser; offer it, do not open it.',
  recipe: {
    size: 'Two seats, critiqueRounds 0, memory stateless, an explicit budget per vendor. That is three calls. Add a seat or a round only when the user asks for depth; each one is another full call per seat.',
    lenses: 'Give every seat a different lens, taken from what the decision could get wrong: risk, cost, evidence, reversibility, long-term effects, user impact. Two seats with one lens mostly agree, which wastes a call.',
    moods: 'Pair one sceptical seat (grill) with one practical seat (builder). Use steelman when the user already leans one way, contrarian when the seats would otherwise agree too early.',
    effort: 'effort low and the lightest model in status for the seats of a small review. Give the chairman one effort step more than the seats (medium when they run low): it judges the arguments, and at low effort it dismisses the hardest objection in a word. Raise one seat, not all, when the decision is hard to reverse.',
    context: 'constraints, known, assumed, reversibility and deadline go into every prompt. Fill them only with facts the user stated; put guesses under assumed, never under known. Leave a field empty rather than invent it.',
    unattended: 'options.unattended true skips every pause: no wait after the blind round, and the seats are told to state what they would have asked as assumptions instead of asking. Off by default; set it only when nobody will answer, since wait then never returns waiting.',
    isolation: 'Live Antigravity requires options.allowLimitedIsolation=true. Set it only when the user has agreed to its limits: session rules deny documented tools, but the CLI cannot disable all shared customizations or MCP discovery. Choose another provider otherwise. Reported prohibited tool activity still stops the seat.',
    research: 'Only when the user requests web research: options.research={query:"public search question",maxSearches:4,timeoutMs:120000}. Adds one fresh CLI call, the searcher, before discussion; only this query goes into research. Optional vendor ("codex", "claude" or "agy"; default "codex"; agy also needs allowLimitedIsolation), model, effort and account set the searcher; without model and effort it runs that vendor\'s lightest model at low effort on the default login. All seats receive the same saved provider-supplied sources. Reported search operations are bounded, but an operation may start before its report arrives. Failed or interrupted research never reruns automatically.',
    agreement: 'When gate.reopenCalls is present, every seat already agrees. Empty answers and no message go straight to the verdict. Any answer text or message runs one more round at reopenCalls calls. Send text only if it could change a seat\'s position; a fact that confirms what the seats already said is better left for the verdict.',
  },
};

try {
  const args = process.argv.slice(2), command = args.shift();
  if (!command || ['help', '--help', '-h'].includes(command) || args.includes('--help')) { console.log(JSON.stringify(HELP)); }
  else {
    if (!Object.hasOwn(HELP.commands, command)) throw new Error('Unknown agent command. Use agent --help.');
    const flags = {};
    while (args.length) {
      const key = args.shift();
      if (key === '--refresh') { flags.refresh = true; continue; }
      if (!['--port', '--id', '--input', '--seconds'].includes(key) || !args.length || Object.hasOwn(flags, key.slice(2))) throw new Error('Invalid or repeated option. Use agent --help.');
      flags[key.slice(2)] = args.shift();
    }
    const port = Number(flags.port || process.env.PORT || 4747);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be a number from 1 to 65535.');
    const base = `http://127.0.0.1:${port}`;
    if (flags.id && !/^[a-z0-9-]+$/.test(flags.id)) throw new Error('Invalid review id.');
    let token = process.env.ROUNDTABLE_TOKEN || '';
    async function request(route, body) {
      if (body !== undefined && !token) {
        const page = await fetch(base, { redirect: 'error', signal: AbortSignal.timeout(8000) });
        if (!page.ok) throw new Error('Could not read the local Roundtable page. Check the port.');
        token = /<meta name="roundtable-token" content="([a-f0-9]{32})">/.exec(await page.text())?.[1] || '';
        if (!token) throw new Error('This port did not serve a Roundtable launch token.');
      }
      const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json', 'x-roundtable-token': token }, body: JSON.stringify(body) }) });
      let result;
      try { result = await response.json(); } catch { throw new Error('The local server returned an unreadable response. Check the port and current review state before retrying.'); }
      if (!response.ok) throw Object.assign(new Error(result.error || 'The local action failed. Read the current state before retrying.'), { status: response.status, diagnostic: result.diagnostic?.id });
      return result;
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
    const route = flags.id ? `/api/debates/${flags.id}` : null;
    const board = (id) => `${base}/#${id}`; // where a person can watch this review in a browser
    let result;
    if (command === 'status' && !route) {
      const setup = await request('/api/seats');
      const pools = setup.vendors.filter((v) => v.kind !== 'api').map((v) => v.vendor);
      const readiness = flags.refresh ? await request('/api/preflight', { pools, fresh: true }) : await request('/api/preflight');
      result = { mode: setup.runtime.mode, providers: setup.vendors.map((v) => ({ vendor: v.vendor, kind: v.kind,
        models: (v.catalogue?.models || []).map((m) => typeof m === 'string' ? m : m.id), efforts: v.catalogue?.efforts || [] })),
        readiness: readiness.pools, next: 'Check a JSON review with agent check --input file. No model call has been made.' };
    } else if (command === 'check') result = await request('/api/preview', await input());
    else if (command === 'start') { const started = await request('/api/debates', await input()); result = { id: started.slug, board: board(started.slug), next: `agent wait --port ${port} --id ${started.slug}` }; }
    else {
      if (!route) throw new Error('This command needs --id from agent start or the board URL.');
      if (command === 'status') result = { ...(await request(`${route}/state`)), board: board(flags.id) };
      else if (command === 'wait') {
        const seconds = Number(flags.seconds || 25);
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error('Wait seconds must be a whole number from 1 to 30.');
        result = await request(`${route}/state`);
        if (['researching', 'running', 'verdict'].includes(result.status)) {
          const controller = new AbortController(), timer = setTimeout(() => controller.abort(), seconds * 1000);
          let reader;
          try {
            const response = await fetch(`${base}${route}/events`, { redirect: 'error', signal: controller.signal, headers: { 'last-event-id': result.revision } });
            if (!response.ok) throw new Error('Could not wait for review events.');
            reader = response.body.getReader();
            const decoder = new TextDecoder(); let buffer = '', finished = false;
            while (!finished) {
              const next = await reader.read(); if (next.done) break;
              buffer += decoder.decode(next.value, { stream: true });
              let end;
              while ((end = buffer.indexOf('\n\n')) >= 0) {
                const event = buffer.slice(0, end).split('\n').find((line) => line.startsWith('data: ')); buffer = buffer.slice(end + 2);
                if (event && ['gate', 'done', 'error', 'interrupted'].includes(JSON.parse(event.slice(6)).type)) finished = true;
              }
            }
          } catch (error) { if (!controller.signal.aborted) throw error; }
          finally { clearTimeout(timer); if (reader) await reader.cancel().catch(() => {}); }
          result = await request(`${route}/state`);
        }
        result = { ...result, board: board(flags.id) };
      } else {
        const body = await input(command === 'answer');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Input must be a JSON object.');
        if (['answer', 'finish', 'stop', 'resume'].includes(command)) body.source = 'agent';
        if (command === 'answer' && !Number.isInteger(body.round)) throw new Error('An answer needs the round number from the current state.');
        result = await request(`${route}/${command === 'answer' ? 'continue' : command === 'verdict' ? 'synthesize' : command}`, body);
        result = { ...result, id: flags.id, board: board(flags.id), next: `agent wait --port ${port} --id ${flags.id}` };
      }
    }
    console.log(JSON.stringify({ ok: true, ...result }));
  }
} catch (error) {
  const message = error.message === 'fetch failed' ? 'Could not reach Roundtable. Start the local server with --no-open and check --port. No write is automatically retried.' : error.message;
  console.log(JSON.stringify({ ok: false, error: message, ...(error.status ? { status: error.status } : {}), ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) }));
  process.exitCode = 1;
}
