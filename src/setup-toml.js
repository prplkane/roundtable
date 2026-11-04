// A lossless TOML declaration scanner, not a value deserializer. Values remain untouched;
// quoted/multiline strings, comments and containers cannot impersonate table/key declarations.
// We only add a fresh table after proving that no existing declaration owns that namespace.
export const MCP_BEGIN = '# BEGIN Roundtable managed MCP';
export const MCP_END = '# END Roundtable managed MCP';
const fail = () => { throw new Error('Unsupported or malformed TOML configuration; it was not changed.'); };

function declarations(text) {
  let i = 0, context = [];
  const entries = [], markers = [];
  const spaces = () => { while (text[i] === ' ' || text[i] === '\t' || text[i] === '\r') i++; };
  function comment(top = false) {
    const start = i;
    while (i < text.length && text[i] !== '\n') i++;
    const content = text.slice(start, i).trimEnd();
    if (top && [MCP_BEGIN, MCP_END].includes(content)) markers.push({ text: content, start, end: start + content.length });
  }
  function quoted(key = false) {
    const start = i, quote = text[i++], triple = text.slice(i, i + 2) === quote.repeat(2);
    if (triple && key) fail();
    if (triple) i += 2;
    let value = '';
    while (i < text.length) {
      const c = text[i++];
      if (!triple && (c === '\n' || c === '\r')) fail();
      if (c === quote) {
        if (!triple) return value;
        if (text.slice(i, i + 2) === quote.repeat(2)) {
          i += 2;
          for (let n = 0; n < 2 && text[i] === quote; n++) i++;
          return text.slice(start, i);
        }
      }
      if (quote === '"' && c === '\\') {
        const escaped = text[i++];
        if (key) {
          if (escaped === 'u' || escaped === 'U') {
            const n = escaped === 'u' ? 4 : 8, hex = text.slice(i, i + n);
            if (hex.length !== n || !/^[0-9a-f]+$/i.test(hex)) fail();
            const point = parseInt(hex, 16);
            if (point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) fail();
            value += String.fromCodePoint(point); i += n;
          } else {
            const escapes = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
            if (!Object.hasOwn(escapes, escaped)) fail();
            value += escapes[escaped];
          }
        }
      } else value += c;
    }
    fail();
  }
  function keyPath() {
    const keys = [];
    while (true) {
      spaces();
      if (text[i] === '"' || text[i] === "'") keys.push(quoted(true));
      else {
        const start = i;
        while (i < text.length && /[A-Za-z0-9_-]/.test(text[i])) i++;
        if (i === start) fail();
        keys.push(text.slice(start, i));
      }
      spaces();
      if (text[i] !== '.') return keys;
      i++;
    }
  }
  function value() {
    spaces();
    if (i >= text.length || text[i] === '#' || text[i] === '\n') fail();
    const stack = [];
    while (i < text.length) {
      const c = text[i];
      if (c === '\n' && !stack.length) return;
      if (c === '#' && !stack.length) { comment(); return; }
      if (c === '#') { comment(); continue; }
      if (c === '"' || c === "'") { quoted(); continue; }
      if (c === '[' || c === '{') stack.push(c);
      if (c === ']' || c === '}') { if (stack.pop() !== (c === ']' ? '[' : '{')) fail(); }
      i++;
    }
    if (stack.length) fail();
  }
  while (i < text.length) {
    spaces();
    if (text[i] === '\n') { i++; continue; }
    if (i >= text.length) break;
    if (text[i] === '#') { comment(true); continue; }
    const start = i;
    if (text[i] === '[') {
      i++; const array = text[i] === '['; if (array) i++;
      context = keyPath();
      if (text[i++] !== ']' || array && text[i++] !== ']') fail();
      entries.push({ start, path: context, table: true, array });
      spaces(); if (text[i] === '#') comment();
      if (i < text.length && text[i] !== '\n') fail();
    } else {
      const keys = keyPath();
      if (text[i++] !== '=') fail();
      entries.push({ start, path: [...context, ...keys], table: false });
      value();
    }
  }
  return { entries, markers };
}

export function tomlConnection(text) {
  const { entries, markers } = declarations(text.replace(/^\uFEFF/, ' '));
  if (markers.length && (markers.length !== 2 || markers[0].text !== MCP_BEGIN || markers[1].text !== MCP_END)) throw new Error('Roundtable configuration markers are damaged; repair them before setup.');
  const start = markers[0]?.start, end = markers[1]?.end;
  for (const d of entries) {
    if (start != null && d.start > start && d.start < end) continue;
    if (d.path[0] !== 'mcp_servers') continue;
    if (d.path[1] === 'roundtable') throw new Error('An existing unmanaged Roundtable MCP entry was found. Keep it or remove it explicitly before using setup.');
    if (d.path.length === 1 && (!d.table || d.array)) throw new Error('Inline or non-table MCP configuration must use TOML tables before setup; it was preserved.');
  }
  return { text, entry: start == null ? null : text.slice(start, end), start, end };
}

export function replaceTomlConnection(current, entry) {
  if (current.entry) return current.text.slice(0, current.start) + (entry || '') + current.text.slice(current.end);
  return `${current.text}${current.text.endsWith('\n') || !current.text ? '' : '\n'}${current.text ? '\n' : ''}${entry}\n`;
}
