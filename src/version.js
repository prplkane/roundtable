// The version is written once, in package.json. The board footer, diagnostics and the Codex
// app-server handshake read it from here, so a release bumps one field and no copy goes stale.
import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
