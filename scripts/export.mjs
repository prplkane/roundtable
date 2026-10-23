// node scripts/export.mjs <slug> <target dir>   (npm run export -- <slug> <target dir>)
// Writes <target>/<slug>.md, the decision record for debates/<slug>/transcript.jsonl, and
// refreshes the index (README.md, or DECISIONS.md when a README exists that roundtable did not
// write). Idempotent: re-exporting replaces both. A file in the way that roundtable did not
// write is refused, never replaced.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDebateDir } from '../src/store.js';
import { exportDebate } from '../src/export.js';

const [slug, target] = process.argv.slice(2);
if (!slug || !target) { console.error('usage: node scripts/export.mjs <slug> <target dir>'); process.exit(2); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const debatesDir = process.env.ROUNDTABLE_DEBATES_DIR ? path.resolve(process.env.ROUNDTABLE_DEBATES_DIR) : path.join(ROOT, 'debates');
const store = openDebateDir(debatesDir, slug, { create: false });
if (!store) { console.error(`no transcript for ${slug} under ${debatesDir}`); process.exit(1); }
try {
  const out = exportDebate(store.readTranscript(), slug, target, { forbid: [debatesDir] });
  console.log(`${out.path}\n${out.indexPath}  (${out.meta.status}: ${out.meta.chosen})`);
} catch (e) { console.error(e.message); process.exit(1); }
