// Shared loopback transport for the CLI and MCP. Never retries a write.
import { VERSION } from './version.js';

export function localClient(port, signal, { requireCurrentVersion = false } = {}) {
  const base = `http://127.0.0.1:${port}`;
  let token = process.env.ROUNDTABLE_TOKEN || '';
  const deadline = (ms) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  async function request(route, body, timeoutMs = 15_000) {
    signal?.throwIfAborted();
    if (body !== undefined && (!token || requireCurrentVersion)) {
      const page = await fetch(base, { redirect: 'error', signal: deadline(8000) });
      if (!page.ok) throw new Error('Could not read the local Roundtable page. Check the port.');
      // The version and one-time-per-launch token come from the same board response.
      // An older board can silently discard options it does not recognize.
      const launchToken = /<meta name="roundtable-token" content="([a-f0-9]{32})">/.exec(await page.text())?.[1];
      if (!launchToken) throw new Error('This port did not serve a Roundtable launch token.');
      if (requireCurrentVersion && page.headers.get('x-roundtable-version') !== VERSION) {
        throw new Error(`The board on port ${port} does not match Roundtable ${VERSION}. Finish active reviews, then restart that board with this installation.`);
      }
      if (token && token !== launchToken) throw Object.assign(new Error('The launch token belongs to a different board session. Refresh it and retry.'), { status: 401 });
      token = launchToken;
      requireCurrentVersion = false;
    }
    const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: deadline(timeoutMs),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json', 'x-roundtable-token': token }, body: JSON.stringify(body) }) });
    let result;
    try {
      let size = 0; const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error('Response exceeds 8 MiB.');
        chunks.push(chunk);
      }
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (e) {
      signal?.throwIfAborted();
      throw new Error(`The local server returned an unreadable or oversized response. Read the current state before retrying.`, { cause: e });
    }
    if (!response.ok) throw Object.assign(new Error(result.error || 'The local action failed. Read the current state before retrying.'), { status: response.status, diagnostic: result.diagnostic?.id });
    return result;
  }
  return { base, request };
}

export function clientError(error) {
  const message = error.message === 'fetch failed' ? 'Could not reach Roundtable. Start the local server with --no-open and check --port. No write is automatically retried.'
    : ['AbortError', 'TimeoutError'].includes(error.name) ? 'Client request cancelled or timed out. The review may still be running; read status before retrying a write.' : error.message;
  return { ok: false, error: message, ...(error.status ? { status: error.status } : {}), ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) };
}
