// The actual logo.svg pixels, cropped to x=2..13, y=2..13. Two vertical pixels per
// terminal cell preserve the round mark's proportions without a tall startup banner.
const PIXELS = [
  '....####....',
  '..##....##..',
  '.#........#.',
  '.#..####..#.',
  '#..######..#',
  '#..######..#',
  '#..######..#',
  '.#..####..#.',
  '.#........#.',
  '..##....##..',
  '....####....',
  '............',
];

export function terminalBanner({ isTTY = process.stdout.isTTY, columns = process.stdout.columns ?? 80, env = process.env } = {}) {
  if (!isTTY || env.CI || env.TERM === 'dumb') return '';
  const ascii = env.ROUNDTABLE_ASCII === '1' || ['C', 'POSIX'].includes(env.LC_ALL || env.LC_CTYPE || env.LANG);
  const mark = ascii ? PIXELS.slice(0, -1).map(row => row.replaceAll('.', '  ').replaceAll('#', '##'))
    : PIXELS.filter((_, y) => y % 2 === 0).map((row, i) => [...row].map((pixel, x) =>
      [' ', '▄', '▀', '█'][(pixel === '#' ? 2 : 0) + (PIXELS[i * 2 + 1][x] === '#' ? 1 : 0)]).join(''));
  // Orchid from the app's Dusk palette; use standard magenta on basic terminals.
  const ink = /truecolor|24bit/i.test(env.COLORTERM || '') || env.WT_SESSION ? '\x1b[38;2;199;154;208m'
    : env.TERM?.includes('256color') ? '\x1b[38;5;182m' : '\x1b[35m';
  const paint = (s, code) => env.NO_COLOR ? s : `${code}${s}\x1b[0m`;
  if (columns < (ascii ? 52 : 40)) return `\n${paint('ROUNDTABLE', ink)}\n\n`;
  const middle = Math.floor(mark.length / 2) - 1;
  const lines = mark.map((row, y) => `  ${paint(row, ink)}${y === middle ? `   ${paint('ROUNDTABLE', '\x1b[1m')}`
    : y === middle + 1 ? '   Local decision reviews' : ''}`);
  return `\n${lines.join('\n')}\n\n`;
}
