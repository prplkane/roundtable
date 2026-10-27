// node scripts/export.mjs <slug> <target dir>   (npm run export -- <slug> <target dir>)
// Writes <target>/<slug>.md, the decision record for a saved session, and
// refreshes the index (README.md, or DECISIONS.md when a README exists that roundtable did not
// write). Idempotent: re-exporting replaces both. A file in the way that roundtable did not
// write is refused, never replaced.
import { openDebateDir } from '../src/store.js';
import { exportDebate } from '../src/export.js';
import { dataDirectory } from '../src/history.js';

const [slug, target] = process.argv.slice(2);
if (!slug || !target) { console.error('usage: node scripts/export.mjs <slug> <target dir>'); process.exit(2); }
const debatesDir = dataDirectory();
const store = openDebateDir(debatesDir, slug, { create: false });
if (!store) { console.error(`no transcript for ${slug} under ${debatesDir}`); process.exit(1); }
try {
  const warnings = [];
  const rows = store.readTranscript({ onWarning: (w) => { warnings.push(w); console.warn(w.message); } });
  const out = exportDebate(rows, slug, target, { forbid: [debatesDir], warnings });
  console.log(`${out.path}\n${out.indexPath}  (${out.meta.status}: ${out.meta.chosen})`);
} catch (e) { console.error(e.message); process.exit(1); }
