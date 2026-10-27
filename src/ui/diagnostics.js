const CODES = new Set(['browser-network', 'browser-timeout', 'browser-response', 'browser-error', 'browser-rejection', 'browser-stream', 'browser-validation']);
const ACTIONS = new Set(['setup', 'history', 'delete', 'clear-finished', 'preflight', 'create', 'events', 'continue', 'finish', 'stop', 'hold', 'resume', 'export', 'synthesize', 'accept', 'pools', 'diagnostics', 'unknown']);
const KEY = 'roundtable.diagnostics';

export function requestAction(url, write = false) {
  if (url === '/api/seats') return 'setup';
  if (url === '/api/debates') return write ? 'create' : 'history';
  if (url === '/api/preflight') return 'preflight';
  if (url.startsWith('/api/diagnostics')) return 'diagnostics';
  if (url.startsWith('/api/pools/')) return 'pools';
  const action = url.split('/').at(-1);
  return ACTIONS.has(action) ? action : 'unknown';
}

function safe(event) {
  if (!/^RT-[a-f0-9]{16}$/.test(event?.id) || !CODES.has(event?.code) || !ACTIONS.has(event?.action)) return null;
  const out = { id: event.id, code: event.code, action: event.action };
  if (['lens', 'moodText'].includes(event.field)) out.field = event.field;
  for (const [key, max] of Object.entries({ seatIndex: 7, status: 599, line: 1_000_000, column: 1_000_000 })) {
    if (Number.isInteger(event[key]) && event[key] >= 0 && event[key] <= max) out[key] = event[key];
  }
  return out;
}

// Diagnostic writes alone may retry. Review actions never do. Keep a small per-tab queue
// through reloads so an offline server or a rotated launch token does not erase the evidence.
export function createBrowserDiagnostics({ send, storage, onPending = () => {} }) {
  let queue = [], sending = null;
  try { const old = JSON.parse(storage?.getItem(KEY) || '[]'); if (Array.isArray(old)) queue = old.map(safe).filter(Boolean).slice(-20); } catch { /* storage disabled */ }
  const persist = () => { try { storage?.setItem(KEY, JSON.stringify(queue)); } catch { /* keep the in-memory copy */ } };
  const pending = () => queue.map((e) => ({ ...e }));
  async function flush() {
    if (sending) return sending;
    if (!queue.length) return;
    const batch = pending();
    sending = (async () => {
      try {
        const reply = await send(batch);
        if (Array.isArray(reply?.saved)) {
          const sent = new Set(batch.map((e) => e.id));
          const saved = new Set(reply.saved.filter((id) => sent.has(id)));
          queue = queue.filter((e) => !saved.has(e.id));
          persist();
        }
      } catch { /* a diagnostics failure must not recursively log itself */ }
      onPending(queue.length);
    })();
    try { await sending; } finally { sending = null; }
  }
  function report(code, action = 'unknown', details = {}) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const id = `RT-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const entry = safe({ ...details, id, code, action });
    if (!entry) return null;
    queue.push(entry); queue = queue.slice(-20); persist();
    void flush();
    return id;
  }
  return { report, flush, pending };
}
