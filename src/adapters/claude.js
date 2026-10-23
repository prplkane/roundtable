// Claude Code: `claude -p --output-format stream-json --verbose`, prompt on stdin, `--resume <id>`.
// Quirks: total_cost_usd is cumulative for the session on resume; common.js takes the delta.
// stream-json is used only so the rate_limit_event line (remaining quota) comes with each reply.
import { makeAdapter } from './common.js';
import { claudeQuota } from './quota.js';
export const run = makeAdapter('claude', { normaliseQuota: claudeQuota });
