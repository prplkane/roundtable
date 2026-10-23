// node src/doctor.js [--live] [--profile <name>] [--vendor <name>]
//
// What this machine can seat. Per vendor: the binary and where it was found, its version, the
// models and effort levels the setup screen will offer, the live pool read where one exists
// (codex), and, with --live, one trivial model call through the adapter: logged in or not,
// what it answered, whether it reached for tools (the guard must see false on a plain reply),
// tokens and the quota it reported (claude). --profile <name> prints how to log that profile
// in for each vendor.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from './adapters/config.js';
import { resolveBinary, runProcess, profileHome, dataDir } from './adapters/spawn.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Shell lines that log a profile in, per vendor, for the platform the user is on. Pure.
export function loginInstructions(vendor, profile, where = {}) {
  const a = ADAPTERS[vendor];
  if (!a?.home) return [`${a?.label || vendor}: the CLI documents no state-directory variable, so a profile cannot be separated from the terminal's login.`];
  const dir = profileHome(vendor, profile, where);
  const login = { claude: 'claude /login', codex: 'codex login' }[vendor] || `${a.binary} login`;
  const platform = where.platform || process.platform;
  const set = platform === 'win32' ? [`set ${a.home.env}=${dir}`, login] : [`${a.home.env}="${dir}" ${login}`];
  return [`${a.label} profile "${profile}" lives in ${dir}`, ...set.map((l) => `  ${l}`), '  (PowerShell: $env:' + a.home.env + ' = "' + dir + '"; ' + login + ')'];
}

async function version(bin, vendor) {
  try {
    const r = await runProcess(bin, ['--version'], { timeoutMs: 20_000 });
    const line = (r.stdout + r.stderr).trim().split('\n').find((l) => /\d+\.\d+/.test(l)) || (r.stdout + r.stderr).trim().split('\n')[0];
    return line ? line.trim().slice(0, 80) : `exit ${r.code}`;
  } catch (e) { return `(${e.message})`; }
}

const flag = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? (process.argv[i + 1] || true) : null; };

async function main() {
  const live = process.argv.includes('--live');
  const profile = flag('profile');
  const only = flag('vendor');
  const { vendorCatalogue } = await import('./adapters/catalogue.js');
  const { adapters, quotaReaders } = await import('./adapters/index.js');
  const catalogue = await vendorCatalogue();
  console.log(`roundtable doctor  (${process.platform}, node ${process.version}, data dir ${dataDir()})`);
  console.log(live ? 'live: one trivial model call per vendor' : 'static only; add --live for one trivial model call per vendor');
  for (const [vendor, a] of Object.entries(ADAPTERS)) {
    if (only && only !== vendor) continue;
    console.log(`\n== ${a.label} (${vendor})  pool: ${a.pool}`);
    if (a.kind === 'api') { // no binary: everything about an endpoint seat is on its card
      console.log('  seat it    on the board: base URL (…/v1), model id, and for a hosted API the NAME of the key variable');
      console.log(`  efforts    ${a.effortLevels.join(', ')}  (reasoning_effort, sent only when set)`);
      console.log(`  read-only  ${a.readOnly}`);
      console.log(`  isolation  ${a.isolation}`);
      continue;
    }
    let bin = null;
    try { bin = resolveBinary(a.binary, a.npmBin); console.log(`  binary     ${bin.prefix.length ? `${bin.prefix[0]} (via node)` : bin.file}`); } catch (e) { console.log(`  binary     NOT FOUND: ${e.message}`); }
    if (bin) console.log(`  version    ${await version(bin, vendor)}`);
    const c = catalogue[vendor];
    console.log(`  models     ${c.models.length ? c.models.map((m) => m.id).join(', ') : '(free text; the CLI lists none)'}${c.defaultModel ? `  default: ${c.defaultModel}` : ''}`);
    console.log(`  efforts    ${c.efforts.join(', ')}${c.defaultEffort ? `  default: ${c.defaultEffort}` : ''}${c.effortInModel ? '  (a model id may carry the level)' : ''}`);
    console.log(`  read-only  ${a.readOnly}`);
    console.log(`  isolation  ${a.isolation}`);
    if (quotaReaders[vendor]) {
      const q = bin ? await quotaReaders[vendor]() : null;
      console.log(`  pool read  ${q ? q.windows.map((w) => `${w.label} ${(w.used * 100).toFixed(0)}% used`).join(', ') + (q.plan ? ` (plan ${q.plan})` : '') : 'no figure (not logged in, or the app-server read failed)'}`);
    } else console.log(`  pool read  ${a.quota === 'per-call' ? 'rides on each reply (shown with --live)' : `none headless; usage page ${a.usageUrl}`}`);
    if (live && bin) {
      const t0 = Date.now();
      try {
        const r = await adapters[vendor]('Reply with exactly the word pong.', null, { timeoutMs: 180_000, cwd: path.join(ROOT, 'debates', '_doctor', vendor) });
        console.log(`  logged in  yes (${Date.now() - t0} ms)  reply: ${JSON.stringify(r.text.slice(0, 40))}  session: ${r.sessionId}`);
        console.log(`  usedTools  ${r.usedTools}${r.usedTools ? '  <- a plain reply reached for tools; the guard would re-prompt it' : ''}`);
        console.log(`  usage      in ${r.usage.input} cache ${r.usage.cacheRead + r.usage.cacheWrite} out ${r.usage.output} think ${r.usage.thinking}${r.usage.cost != null ? ` $${r.usage.cost.toFixed(2)}` : ''}`);
        if (r.quota) console.log(`  windows    ${r.quota.windows.map((w) => `${w.label} ${(w.used * 100).toFixed(0)}% used`).join(', ')}`);
      } catch (e) { console.log(`  logged in  NO or failed (${Date.now() - t0} ms): ${e.message.slice(0, 200)}`); }
    }
    if (profile) for (const l of loginInstructions(vendor, profile)) console.log(`  profile    ${l}`);
  }
  if (!profile) console.log('\nadd --profile <name> to see how to log a named account profile in for each vendor');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
