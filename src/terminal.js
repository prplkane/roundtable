import { VERSION } from './version.js';

// The app's logo tile, pixel for pixel (src/ui/logo.svg): the round table on its 16x16 tile,
// orchid with aubergine ink like the board header. Half blocks put two pixel rows in one
// terminal cell, so the tile keeps its square shape at 16 columns by 8 rows.
const TILE = [
  '................', '................',
  '......####......', '....##....##....', '...#........#...', '...#..####..#...',
  '..#..######..#..', '..#..######..#..', '..#..######..#..', '...#..####..#...',
  '...#........#...', '....##....##....', '......####......',
  '................', '................', '................',
];
const TAGLINE = 'Local decision reviews';
const RESET = '\x1b[0m';

// Half blocks need a UTF-8 terminal. Windows consoles take UTF-16 from Node whatever the code
// page; elsewhere the locale has to say so. ROUNDTABLE_ASCII=1 forces the plain form.
const unicode = (env, platform) => env.ROUNDTABLE_ASCII !== '1'
  && (platform === 'win32' || /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || ''));
// Tile and ink colours: true colour where the terminal says so, the nearest 256-colour or
// basic pair otherwise. Returned as [tile background, ink foreground, orchid foreground].
function palette(env, platform) {
  if (/truecolor|24bit/i.test(env.COLORTERM || '') || env.WT_SESSION || platform === 'win32') return ['\x1b[48;2;199;154;208m', '\x1b[38;2;43;29;56m', '\x1b[38;2;199;154;208m'];
  if (env.TERM?.includes('256color')) return ['\x1b[48;5;182m', '\x1b[38;5;234m', '\x1b[38;5;182m'];
  return ['\x1b[45m', '\x1b[30m', '\x1b[35m'];
}

function tileRows(colour) {
  const rows = [];
  for (let y = 0; y < TILE.length; y += 2) {
    let line = '';
    for (let x = 0; x < 16; x++) {
      const top = TILE[y][x] === '#', bottom = TILE[y + 1][x] === '#';
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    rows.push(colour(line));
  }
  return rows;
}

export function terminalBanner({ isTTY = process.stdout.isTTY, columns = process.stdout.columns ?? 80, env = process.env, platform = process.platform } = {}) {
  if (!isTTY || env.CI || env.TERM === 'dumb') return '';
  const paint = (s, code) => env.NO_COLOR ? s : `${code}${s}${RESET}`;
  const [tile, ink, orchid] = palette(env, platform);
  const version = `v${VERSION}`;
  const name = paint('ROUNDTABLE', '\x1b[1m');
  const compact = `${name}${columns >= 12 + version.length ? `  ${paint(version, '\x1b[2m')}` : ''}`;
  // 2 indent + 16 tile + 3 gap + the tagline, the widest line beside the tile
  if (!unicode(env, platform) || columns < 21 + TAGLINE.length) return `\n${compact}\n\n`;
  const beside = { 2: `${name} ${paint('▌', orchid)}`, 3: paint(version, '\x1b[2m'), 5: paint(TAGLINE, '\x1b[2m') };
  const lines = tileRows((row) => paint(row, tile + ink)).map((row, y) => `  ${row}${beside[y] ? `   ${beside[y]}` : ''}`);
  return `\n${lines.join('\n')}\n\n`;
}
