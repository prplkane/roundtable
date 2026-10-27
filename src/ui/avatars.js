// Pixel avatars for the seat cards: one per mood, plus the chairman's gavel. 12x12, one colour
// (currentColor, so the card's vendor colour), drawn with crisp edges like the logo tile.
// The shape says how the seat argues; the colour says whose CLI it is.

const ART = {
  grill: [ // a magnifying glass: attack assumptions, demand evidence
    '...XXXX.....',
    '..X....X....',
    '.X......X...',
    'X...XX...X..',
    'X..X.....X..',
    'X..X.....X..',
    'X........X..',
    '.X......X...',
    '..X....XX...',
    '...XXXX.XX..',
    '.........XX.',
    '..........XX',
  ],
  steelman: [ // a shield: the strongest version of each option first
    '.XXXXXXXXXX.',
    '.X........X.',
    '.X...XX...X.',
    '.X...XX...X.',
    '.X.XXXXXX.X.',
    '.X...XX...X.',
    '.X...XX...X.',
    '..X..XX..X..',
    '..X......X..',
    '...X....X...',
    '....X..X....',
    '.....XX.....',
  ],
  builder: [ // a hammer: what it takes to ship
    '..XXXXXXX...',
    '.XXXXXXXXXX.',
    '.XXXXXXXXX..',
    '..XXXXXXX...',
    '.....XX.....',
    '.....XX.....',
    '.....XX.....',
    '.....XX.....',
    '.....XX.....',
    '.....XX.....',
    '....XXXX....',
    '....XXXX....',
  ],
  contrarian: [ // opposed arrows: the stance the others are least likely to take
    '...X........',
    '..XX........',
    '.XXXXXXXXXX.',
    '..XX........',
    '...X........',
    '............',
    '............',
    '........X...',
    '........XX..',
    '.XXXXXXXXXX.',
    '........XX..',
    '........X...',
  ],
  custom: [ // a quill: the seat's own sentence
    '..........XX',
    '.........XXX',
    '........XXX.',
    '.......XXX..',
    '......XXX...',
    '.....XXX....',
    '....XXX.....',
    '...XXX......',
    '...XX.......',
    '..X.........',
    '.X..........',
    'X...........',
  ],
  chairman: [ // a gavel: writes the verdict; the human decides
    '..XXX.......',
    '.XXXXX......',
    'XXXXXXX.....',
    '.XXXXXXX....',
    '..XXXXXXX...',
    '...XXXXX.X..',
    '....XXX...X.',
    '...........X',
    '............',
    'XXXXXXXX....',
    'XXXXXXXX....',
    '............',
  ],
};

// Each run of filled cells in a row is one rect, so a pixel drawing stays small. The session
// ceremony draws its larger gavel with the same helper, so both read as one family.
export function pixelRects(rows, mark = 'X') {
  const rects = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== mark) continue;
      let w = 1;
      while (row[x + w] === mark) w++;
      rects.push(`<rect x="${x}" y="${y}" width="${w}" height="1"/>`);
      x += w - 1;
    }
  });
  return rects.join('');
}

// The raw rows, for a drawing built from the same art elsewhere (the session gavel).
export const sprite = (name) => ART[name] || ART.grill;

// One <svg> per avatar.
export function avatar(name) {
  const rects = pixelRects(ART[name] || ART.grill);
  return `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" fill="currentColor" aria-hidden="true">${rects}</svg>`;
}
