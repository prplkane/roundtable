// Codex: `codex exec --json`, prompt on stdin (`-`), `exec resume <id>`.
// Quirks: usage comes in the turn.completed event, no cost; `resume` rejects --sandbox so the
// policy is passed with -c sandbox_mode; the PATH entry is an npm .cmd shim, so spawn.js runs
// bin/codex.js through node instead.
import { makeAdapter } from './common.js';
export const run = makeAdapter('codex');
