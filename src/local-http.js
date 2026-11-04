// Shared loopback transport for the CLI and MCP. Never retries a write.
export function localClient(port, signal) {
  const base = `http://127.0.0.1:${port}`;
  let token = process.env.ROUNDTABLE_TOKEN || '';
  const deadline = (ms) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  async function request(route, body) {
    signal?.throwIfAborted();
    if (body !== undefined && !token) {
      const page = await fetch(base, { redirect: 'error', signal: deadline(8000) });
      if (!page.ok) throw new Error('Could not read the local Roundtable page. Check the port.');
      token = /<meta name="roundtable-token" content="([a-f0-9]{32})">/.exec(await page.text())?.[1] || '';
      if (!token) throw new Error('This port did not serve a Roundtable launch token.');
    }
    const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: deadline(15000),
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
