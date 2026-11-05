import { VERSION } from './version.js';

// A line-art interpretation of the logo's ring and central table. Printable ASCII
// keeps the contours consistent across terminal fonts, locales and operating systems.
const MARK = [
  '      .-------.      ',
  "   .-'         '-.   ",
  ' /     .-----.     \\ ',
  '|     (       )     |',
  " \\     '-----'     / ",
  "   '-.         .-'   ",
  "      '-------'      ",
];

export function terminalBanner({ isTTY = process.stdout.isTTY, columns = process.stdout.columns ?? 80, env = process.env } = {}) {
  if (!isTTY || env.CI || env.TERM === 'dumb') return '';
  // Orchid from the app's Dusk palette; use standard magenta on basic terminals.
  const ink = /truecolor|24bit/i.test(env.COLORTERM || '') || env.WT_SESSION ? '\x1b[38;2;199;154;208m'
    : env.TERM?.includes('256color') ? '\x1b[38;5;182m' : '\x1b[35m';
  const paint = (s, code) => env.NO_COLOR ? s : `${code}${s}\x1b[0m`;
  const name = paint('ROUNDTABLE', '\x1b[1m');
  const version = `v${VERSION}`;
  const title = `${name}${columns >= 12 + version.length ? `  ${paint(version, '\x1b[2m')}` : ''}`;
  const subtitle = 'Local decision reviews';
  if (columns < 27 + Math.max(subtitle.length, 12 + version.length)) return `\n${title}\n\n`;
  const lines = MARK.map((row, y) => `  ${paint(row, ink)}${y === 3 ? `    ${title}`
    : y === 4 ? `    ${paint(subtitle, '\x1b[2m')}` : ''}`);
  return `\n${lines.join('\n')}\n\n`;
}
