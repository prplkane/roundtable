import { LIMITS } from './validate.js';
import { localClient } from './local-http.js';

export const HELP = {
  usage: 'roundtable agent <status|check|start|wait|answer|hold|finish|stop|resume|verdict> [--port 4747] [--id review-id] [--input file|-] [--seconds 25] [--after-round round] [--refresh]',
  commands: {
    status: 'Without --id: cached provider setup. With --id: current step, questions, latest positions and verdict. --refresh refreshes free CLI status checks.',
    check: 'Validate --input and estimate calls/tokens without creating a review.',
    start: 'Start the review in --input. Uses the selected providers. Returns its id immediately.',
    wait: 'Wait up to --seconds (1–30) for a question or completion. After presenting questions, use --after-round N to wait for the next step without asking the same questions again. Returns one state object, not an event log.',
    answer: 'Send --input {round, answers:[{id:"q1",text:"..."}], message:"optional note"}, labelled as an agent note. Read the current state first; never invent a missing answer.',
    hold: 'Send --input {round} to give the user another answer window. This is a bounded extension, not an indefinite pause. It makes no model call.',
    stop: 'Cancel all in-flight calls, including the chairman; keep completed replies. A verdict runs later only if explicitly requested.',
    finish: 'End discussion and write the verdict from collected replies. Available after one complete round has a usable reply; may make a chairman call.',
    resume: 'Resume an interrupted review. May make provider calls.',
    verdict: 'Request a missing or failed verdict from saved replies. May make a provider call.',
  },
  acp: 'To use a saved AgentLink profile, select vendor="acp" and account="profile-name" for each seat and the chairman. Requires stateless memory and allowLimitedIsolation=true after the person accepts profile-owned permissions, customization and billing. Roundtable denies client tools and stops reported tool activity. AgentLink must already be installed/configured. Missing token usage stays unknown and stops further calls for that seat under its cap; no live quota is inferred.',
  setup: 'Use roundtable server status to inspect the local board; roundtable server start launches it hidden if needed (add --fake for a free test). After an update, server restart refuses active reviews. This client reads its launch token locally; it never prints or stores the token.',
  input: 'check/start accept the same {fieldNotes,seats,chairman,options} JSON as the board. Check available providers first. Every result with an id carries board, a link where a person can watch the review in a browser; offer it, do not open it.',
  recipe: {
    questions: 'When nextAction.type is ask_user, present gate.questions with an available user-input tool; if unavailable, ask in normal chat. Tell the user when the answer window closes (gate.secondsUntilAutoContinue, or gate.autoContinueAtIso; autoContinueAt is epoch milliseconds) and that unknowns stay unknown. Send the user\'s own reply as answers with from "user"; anything you add yourself goes in message, or in an answer with from "assistant". Do not just print JSON or answer for the user. In an async host, use nextAction.waitCommand while the question is pending; await_user means it has already been shown, so do not ask again. Read status before sending the user reply; if the round has advanced, preserve the reply and report that it was not submitted. Use hold only when the person needs more time, never as an automatic keepalive.',
    size: 'Normally use two seats, critiqueRounds 1 (the engine default), memory stateless and an explicit budget per vendor: up to five calls before repairs. Use 0 only for a requested quick comparison and disclose that the seats did not respond to each other. Consider 2 for a requested deep review or a decision with several consequential trade-offs, within the user\'s time and budget. Consensus can end discussion early. Do not automatically start another review or exceed agreed limits because disagreement remains.',
    completion: 'A start acknowledgement or seat positions are not a completed review. Keep waiting through status running and verdict until status done and verdict.status ready. If interrupted, failed, skipped or missing, report that limitation instead of supplying your own chairman result. Include the review id, board link and depth.completedCritiqueRounds in the final report.',
    lenses: 'Give every seat a different lens, taken from what the decision could get wrong: risk, cost, evidence, reversibility, long-term effects, user impact. Two seats with one lens mostly agree, which wastes a call.',
    moods: 'Pair one sceptical seat (grill) with one practical seat (builder). Use steelman when the user already leans one way, contrarian when the seats would otherwise agree too early.',
    effort: 'effort low and the lightest model in status for the seats of a small review. Give the chairman one effort step more than the seats (medium when they run low): it judges the arguments, and at low effort it dismisses the hardest objection in a word. Raise one seat, not all, when the decision is hard to reverse.',
    context: 'constraints, known, assumed, reversibility and deadline go into every prompt. Fill them only with facts the user stated; put guesses under assumed, never under known. Leave a field empty rather than invent it.',
    unattended: 'Use options.unattended true for a background job with nobody to answer: it skips all pauses and keeps missing facts as assumptions. Live chat or browser reviews leave it false: ordinary checkpoints last autoContinueMs (15 seconds by default), questions last questionWaitMs (2 minutes). No answer continues automatically, without accepting a recommendation. Both modes respect the review wall clock.',
    isolation: 'Live Antigravity requires options.allowLimitedIsolation=true. Set it only when the user has agreed to its limits: session rules deny documented tools, but the CLI cannot disable all shared customizations or MCP discovery. Choose another provider otherwise. Reported prohibited tool activity still stops the seat.',
    terms: 'Live Antigravity also requires options.acknowledgeTermsRisk=true, for every seat, chairman or searcher on agy. Google\'s Antigravity FAQ says wrapping agy in third-party applications is not supported under consumer plans and that third-party access can get the account suspended or terminated. Show the person providers[].terms.notice and its url from status, and set the option only when they have agreed for this review; an acknowledgment on the board does not answer for an agent request. Choose another provider otherwise.',
    research: 'Only when the user requests web research: options.research={query:"public search question",maxSearches:4,timeoutMs:120000}. Adds one fresh CLI call, the searcher, before discussion; only this query goes into research. Optional vendor ("codex", "claude" or "agy"; default "codex"; agy also needs allowLimitedIsolation and acknowledgeTermsRisk), model, effort and account set the searcher; without model and effort it runs that vendor\'s lightest model at low effort on the default login. All seats receive the same saved provider-supplied sources. Reported search operations are bounded, but an operation may start before its report arrives. Failed or interrupted research never reruns automatically.',
    agreement: 'When gate.reopenCalls is present, every seat already agrees. Empty answers and no message go straight to the verdict. Any answer text or message runs one more round at reopenCalls calls. Send text only if it could change a seat\'s position; a fact that confirms what the seats already said is better left for the verdict.',
  },
};

export async function runAgent(command, flags = {}, input, signal) {
  if (command === 'guide') return HELP;
  if (!Object.hasOwn(HELP.commands, command)) throw new Error('Unknown agent command. Use agent --help.');
  const port = Number(flags.port || process.env.PORT || 4747);
  if (!Number.isInteger(port) || port < LIMITS.port[0] || port > LIMITS.port[1]) throw new Error('Port must be a number from 1 to 65535.');
  if (flags.id && !/^[a-z0-9-]+$/.test(flags.id)) throw new Error('Invalid review id.');
  const { base, request } = localClient(port, signal);
  const route = flags.id ? `/api/debates/${flags.id}` : null;
  const board = (id) => `${base}/#${id}`; // where a person can watch this review in a browser
  let result;
  if (command === 'status' && !route) {
    const setup = await request('/api/seats?cached=1');
    const pools = setup.vendors.filter((v) => v.kind !== 'api').map((v) => v.vendor);
    const readiness = flags.refresh ? await request('/api/preflight', { pools, fresh: true }) : await request('/api/preflight');
    result = { mode: setup.runtime.mode, cataloguePending: setup.runtime.cataloguePending === true, providers: setup.vendors.map((v) => ({ vendor: v.vendor, kind: v.kind,
      models: (v.catalogue?.models || []).map((m) => typeof m === 'string' ? m : m.id), efforts: v.catalogue?.efforts || [],
      ...(v.terms ? { terms: { notice: v.terms.notice, url: v.terms.url, acknowledgedOnBoard: v.terms.acknowledgedAt != null } } : {}) })),
      readiness: readiness.pools, defaults: setup.defaults, next: 'Check a JSON review with agent check --input file. No model call has been made.' };
  } else if (command === 'check') result = await request('/api/preview', input);
  else if (command === 'start') { const started = await request('/api/debates', input); result = { id: started.slug, board: board(started.slug), next: `agent wait --port ${port} --id ${started.slug}` }; }
  else {
    if (!route) throw new Error('This command needs --id from agent start or the board URL.');
    if (command === 'status') result = { ...(await request(`${route}/state`)), board: board(flags.id) };
    else if (command === 'wait') {
      const seconds = Number(flags.seconds || 25);
      if (!Number.isInteger(seconds) || seconds < LIMITS.waitSeconds[0] || seconds > LIMITS.waitSeconds[1]) throw new Error('Wait seconds must be a whole number from 1 to 30.');
      const afterRound = flags['after-round'] == null ? -1 : Number(flags['after-round']);
      if (!Number.isInteger(afterRound) || afterRound < -1 || afterRound > LIMITS.critiqueRounds[1] || flags['after-round'] != null && afterRound < 0) throw new Error('After round must be a whole number from 0 to 8.');
      result = await request(`${route}/state`);
      if (['researching', 'running', 'verdict'].includes(result.status) || result.status === 'waiting' && (result.gate?.round === afterRound || result.gate?.mode === 'countdown' && !result.gate.questions.length)) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), seconds * 1000);
        const waiting = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        let reader;
        // Node 22 can lose fetch's abort link after collection while an SSE body
        // is idle. Cancel the held reader directly so its pending read settles.
        const cancelRead = () => { reader?.cancel().catch(() => {}); };
        waiting.addEventListener('abort', cancelRead, { once: true });
        try {
          const response = await fetch(`${base}${route}/events`, { redirect: 'error', signal: waiting, headers: { 'last-event-id': result.revision } });
          if (!response.ok) throw new Error('Could not wait for review events.');
          reader = response.body.getReader();
          waiting.throwIfAborted();
          const decoder = new TextDecoder(); let buffer = '', finished = false;
          while (!finished) {
            const next = await reader.read(); if (next.done) break;
            buffer += decoder.decode(next.value, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const event = buffer.slice(0, end).split('\n').find((line) => line.startsWith('data: ')); buffer = buffer.slice(end + 2);
              if (event) {
                const update = JSON.parse(event.slice(6));
                if (['done', 'error', 'interrupted'].includes(update.type) || update.type === 'gate' && update.round !== afterRound && (update.questions?.length || update.mode === 'blocking')) finished = true;
              }
            }
          }
          signal?.throwIfAborted();
        } catch (error) { signal?.throwIfAborted(); if (!controller.signal.aborted) throw error; }
        finally {
          clearTimeout(timer);
          waiting.removeEventListener('abort', cancelRead);
          if (reader) await reader.cancel().catch(() => {});
        }
        result = await request(`${route}/state`);
      }
      result = { ...result, board: board(flags.id) };
      if (result.nextAction?.type === 'ask_user' && result.gate.round === afterRound) {
        result.nextAction = { ...result.nextAction, type: 'await_user', instruction: 'These questions have already been presented. Keep the existing prompt pending; do not ask again or invent answers. Read status before submitting a reply. Use waitCommand to wait for another step without extending the response window.' };
      }
    } else {
      const body = structuredClone(input ?? {});
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Input must be a JSON object.');
      if (['answer', 'finish', 'stop', 'resume'].includes(command)) body.source = 'agent';
      if (['answer', 'hold'].includes(command) && !Number.isInteger(body.round)) throw new Error('An answer or time extension needs the round number from the current state.');
      result = await request(`${route}/${command === 'answer' ? 'continue' : command === 'verdict' ? 'synthesize' : command}`, body);
      result = { ...result, id: flags.id, board: board(flags.id), next: `agent wait --port ${port} --id ${flags.id}` };
    }
  }
  if (['ask_user', 'await_user'].includes(result.nextAction?.type)) {
    result.nextAction.command = `agent answer --port ${port} --id ${flags.id} --input -`;
    result.nextAction.waitCommand = `agent wait --port ${port} --id ${flags.id} --after-round ${result.gate.round}`;
    result.nextAction.extend = { command: `agent hold --port ${port} --id ${flags.id} --input -`, input: { round: result.gate.round } };
  }
  return { ok: true, ...result };
}
