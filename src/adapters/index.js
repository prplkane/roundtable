import { run as claude } from './claude.js';
import { run as codex } from './codex.js';
import { run as agy } from './agy.js';
import { run as api } from './endpoint.js';
import { ADAPTERS, poolsByAccount } from './config.js';
import { readCodexQuota } from './quota.js';

export const adapters = { claude, codex, agy, api };
// Vendors whose quota needs a separate read (no model call). The others ride on replies or have none.
export const quotaReaders = { codex: readCodexQuota };
export { ADAPTERS, poolsByAccount };
