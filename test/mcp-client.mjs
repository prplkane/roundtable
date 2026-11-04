import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';

export const exec = promisify(execFile);
export const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

export function mcpClient(command, args, options = {}) {
  const { requestTimeoutMs = 60000, ...spawnOptions } = options;
  const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...spawnOptions });
  let seq = 0, buffer = '', stderr = '';
  const pending = new Map();
  const failAll = (e) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); } pending.clear(); };
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { failAll(new Error(`Non-protocol stdout: ${line.slice(0, 200)}`)); continue; }
      const p = pending.get(message.id);
      if (p) { clearTimeout(p.timer); pending.delete(message.id); message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result); }
    }
  });
  child.stderr.setEncoding('utf8').on('data', (s) => { stderr += s; });
  child.on('error', failAll);
  child.on('exit', (code) => failAll(new Error(`MCP exited ${code}: ${stderr.slice(0, 500)}`)));
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  const request = (method, params = {}) => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request timed out: ${method}`)); }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };
  return { child, request, notify, stderr: () => stderr,
    async initialize(version = '2025-11-25') {
      const result = await request('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'roundtable-test', version: '1' } });
      notify('notifications/initialized'); return result;
    },
    async tool(command, args = {}) {
      const result = await request('tools/call', { name: `roundtable_${command}`, arguments: args });
      const data = JSON.parse(result.content[0].text);
      if (JSON.stringify(data) !== JSON.stringify(result.structuredContent)) throw new Error('Text and structured results differ.');
      return data;
    },
    close() { return new Promise((resolve) => { if (child.exitCode != null) return resolve(); child.once('exit', resolve); child.stdin.end(); const timer = setTimeout(() => child.kill(), 2000); timer.unref(); }); },
  };
}
