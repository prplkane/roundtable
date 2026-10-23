// Antigravity CLI: `agy --output-format json -p=<prompt>`, `--conversation <id>` to resume.
// Quirks: `-p` needs its value attached (`-p=...`) and stdin is ignored in that mode; for long
// prompts common.js switches to --input-format stream-json, where each stdin line is
// {"event":"user","message":{"role":"user","content":...}} and the last stdout line is
// {"event":"result","result":{...same shape as --output-format json...}}. No cost reported.
import { makeAdapter } from './common.js';
export const run = makeAdapter('agy');
