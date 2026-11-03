// A vendor whose own docs say wrapping its CLI is unsupported or against its terms on some plans
// (config.js `terms`; today Antigravity). Nothing is sent to that CLI until the person has
// acknowledged the notice:
//
//   on the board, once: kept per data folder in _terms.json, so the server knows at start whether
//     it may read the CLI's model list and quota in the background. Only the board page records
//     it (server.js fromBoard); an agent cannot change it for the machine.
//   per request: options.acknowledgeTermsRisk. The board sends it once acknowledged; an agent
//     sends it only when the person has agreed. A live server refuses an Antigravity seat,
//     chairman or searcher without it, and the adapter refuses the call (TERMS_ACK_REQUIRED).
import { createSettingsStore } from './settings.js';

// The vendors on a table that carry a terms notice: seats, chairman and searcher. Pure.
export function termsVendors(cards, adapters) {
  return [...new Set(cards.filter((s) => s && adapters[s.vendor]?.terms).map((s) => s.vendor))];
}

// The refusal for a request that would run such a vendor without the acknowledgment, or null. Pure.
export function termsRefusal(cards, options, adapters) {
  const vendors = termsVendors(cards, adapters);
  if (!vendors.length || options?.acknowledgeTermsRisk === true) return null;
  const notices = vendors.map((v) => adapters[v].terms.notice).join(' ');
  return Object.assign(new Error(`${notices} Acknowledge this on the board, or send options.acknowledgeTermsRisk: true once the person has agreed, or choose another provider.`),
    { status: 400, code: 'TERMS_ACK_REQUIRED' });
}

// The board's acknowledgment per vendor, { at, read }: when it was given and the date of the
// notice it answered (config.js terms.read). A notice checked again later counts as not
// acknowledged, so the board asks again. A vendor without a notice is always clear.
export function createTermsRecord(file, { adapters, onError, now = Date.now } = {}) {
  const store = createSettingsStore(file, { onError });
  let value = store.value;
  const acknowledged = (vendor) => {
    const t = adapters[vendor]?.terms;
    return !t || (value[vendor]?.read === t.read && Number.isFinite(value[vendor]?.at));
  };
  // what /api/seats tells the board about one vendor; null when it has no notice
  const status = (vendor) => {
    const t = adapters[vendor]?.terms;
    return t ? { url: t.url, read: t.read, notice: t.notice, acknowledgedAt: acknowledged(vendor) ? value[vendor].at : null } : null;
  };
  function set(vendor, yes) {
    if (!adapters[vendor]?.terms) throw Object.assign(new Error('This provider has no terms notice to acknowledge.'), { status: 400 });
    const next = { ...value };
    if (yes) next[vendor] = { at: now(), read: adapters[vendor].terms.read };
    else delete next[vendor];
    store.save(next);
    value = next;
    return status(vendor);
  }
  return { acknowledged, status, set };
}
