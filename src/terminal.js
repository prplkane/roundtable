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
const BOLD = '\x1b[1m', DIM = '\x1b[2m', BLINK = '\x1b[5m';

// Half blocks need a UTF-8 terminal. Windows consoles take UTF-16 from Node whatever the code
// page; elsewhere the locale has to say so. ROUNDTABLE_ASCII=1 forces the plain form.
const unicode = (env, platform) => env.ROUNDTABLE_ASCII !== '1'
  && (platform === 'win32' || /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || ''));
// Which colours the terminal takes: true colour where it says so, 256 colours, or the basic 8.
const tier = (env, platform) => (/truecolor|24bit/i.test(env.COLORTERM || '') || env.WT_SESSION || platform === 'win32') ? 'true'
  : env.TERM?.includes('256color') ? '256' : 'basic';
// Tile and ink colours per tier: [tile background, ink foreground, orchid foreground].
const PALETTE = {
  true: ['\x1b[48;2;199;154;208m', '\x1b[38;2;43;29;56m', '\x1b[38;2;199;154;208m'],
  256: ['\x1b[48;5;182m', '\x1b[38;5;234m', '\x1b[38;5;182m'],
  basic: ['\x1b[45m', '\x1b[30m', '\x1b[35m'],
};
// The family accents the board gives each vendor (adapters/config.js colour, design/app.css
// --seat-*), per tier, so a vendor reads the same colour in the terminal as on its seat.
const ACCENTS = {
  rust: ['\x1b[38;2;223;107;85m', '\x1b[38;5;173m', '\x1b[31m'],
  olive: ['\x1b[38;2;156;188;106m', '\x1b[38;5;149m', '\x1b[32m'],
  teal: ['\x1b[38;2;111;179;169m', '\x1b[38;5;73m', '\x1b[36m'],
  steel: ['\x1b[38;2;134;169;196m', '\x1b[38;5;110m', '\x1b[34m'],
};
const TIERS = ['true', '256', 'basic'];

// Nothing is decorated for a pipe, CI or a dumb terminal; NO_COLOR keeps the text and drops
// the codes.
const decorated = (isTTY, env) => isTTY && !env.CI && env.TERM !== 'dumb';
const painter = (env) => (s, code) => env.NO_COLOR ? s : `${code}${s}${RESET}`;

// A vendor's name in its seat colour: paintVendor(ADAPTERS.codex) -> coloured "Codex".
export function paintVendor({ label, colour }, { text = label, isTTY = process.stdout.isTTY, env = process.env, platform = process.platform } = {}) {
  if (!decorated(isTTY, env) || !ACCENTS[colour]) return text;
  return painter(env)(text, ACCENTS[colour][TIERS.indexOf(tier(env, platform))]);
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
  if (!decorated(isTTY, env)) return '';
  const paint = painter(env);
  const [tile, ink, orchid] = PALETTE[tier(env, platform)];
  const version = `v${VERSION}`;
  const name = paint('ROUNDTABLE', BOLD);
  const compact = `${name}${columns >= 12 + version.length ? `  ${paint(version, DIM)}` : ''}`;
  // 2 indent + 16 tile + 3 gap + the tagline, the widest line beside the tile
  if (!unicode(env, platform) || columns < 21 + TAGLINE.length) return `\n${compact}\n\n`;
  // the block cursor blinks like the board header's, where the terminal allows blinking text
  const beside = { 2: `${name} ${paint('▌', orchid + BLINK)}`, 3: paint(version, DIM), 5: paint(TAGLINE, DIM) };
  const lines = tileRows((row) => paint(row, tile + ink)).map((row, y) => `  ${row}${beside[y] ? `   ${beside[y]}` : ''}`);
  return `\n${lines.join('\n')}\n\n`;
}
