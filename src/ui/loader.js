// The loading mark: the Roundtable logo drawn straight on the page, no tile or frame. The table at
// the centre stays lit. The ring of seats breathes slowly, one pixel out and back, one pixel in
// and back, while a light runs round it clockwise, a bright head with a short trail.
//
// Every pixel sits on the logo's own 16x16 grid, so it stays crisp at any size. The middle ring
// is the logo's own; the inner and outer rings are drawn the same way (a flat top, a two-pixel
// step, straight sides), one pixel smaller and larger on every side. Each seat carries its angle
// as a fraction of a lap, so the running light keeps its place when the ring changes size. The
// timing is CSS (app.css, "Loading"); reduced motion shows the logo, lit.

const TABLE = [
  '................', '................', '................', '................', '................',
  '......####......',
  '.....######.....',
  '.....######.....',
  '.....######.....',
  '......####......',
];
const RINGS = {
  in: [
    '................', '................', '................',
    '......####......',
    '....##....##....',
    '...#........#...',
    '...#........#...',
    '...#........#...',
    '...#........#...',
    '...#........#...',
    '....##....##....',
    '......####......',
  ],
  mid: [
    '................', '................',
    '......####......',
    '....##....##....',
    '...#........#...',
    '...#........#...',
    '..#..........#..',
    '..#..........#..',
    '..#..........#..',
    '...#........#...',
    '...#........#...',
    '....##....##....',
    '......####......',
  ],
  out: [
    '................',
    '.....######.....',
    '...##......##...',
    '..#..........#..',
    '..#..........#..',
    '.#............#.',
    '.#............#.',
    '.#............#.',
    '.#............#.',
    '.#............#.',
    '..#..........#..',
    '..#..........#..',
    '...##......##...',
    '.....######.....',
  ],
};

const cells = (rows) => rows.flatMap((row, y) => [...row].map((c, x) => (c === '#' ? [x, y] : null)).filter(Boolean));
// The logo's middle is (8, 7.5) in pixel-centre terms: twelve columns wide, eleven rows tall.
const turn = (x, y) => { const a = Math.atan2(x + 0.5 - 8, -(y + 0.5 - 7.5)); return (a < 0 ? a + 2 * Math.PI : a) / (2 * Math.PI); };

export function loaderMarkup() {
  const rect = ([x, y], extra = '') => `<rect x="${x}" y="${y}" width="1" height="1"${extra}/>`;
  const ring = (name) => `<g class="loader-ring loader-${name}">${cells(RINGS[name]).map((p) => rect(p, ` class="loader-seat" style="--a:${turn(...p).toFixed(3)}"`)).join('')}</g>`;
  return `<svg class="loader" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true" focusable="false">
    <g class="loader-table">${cells(TABLE).map((p) => rect(p)).join('')}</g>${ring('in')}${ring('mid')}${ring('out')}</svg>`;
}
