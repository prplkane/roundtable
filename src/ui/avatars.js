// Pixel avatars for the seat cards: one per mood, plus the chairman's gavel. 12x12, one colour
// (currentColor, so the card's vendor colour), drawn with crisp edges like the logo tile.
// The shape says how the seat argues; the colour says whose CLI it is.

const ART = {
  grill: [ // a pointing hand, thumb up (a nod to Ace Attorney's "Objection!"): attack assumptions, demand evidence
    '............',
    '...XX.......',
    '...XX.......',
    'XX.XXXXXXXXX',
    'XX.XXXXXXXXX',
    'XX.XXXXX....',
    'XX.XXXX.....',
    'XX.XXXXX....',
    'XX..XXX.....',
    '............',
    '............',
    '............',
  ],
  steelman: [ // a heater shield with a gem at its heart (a nod to The Rising of the Shield Hero): the strongest version of each option first
    'XXXXXXXXXXXX',
    'XXXXXXXXXXXX',
    'XXXXX..XXXXX',
    'XXXX.XX.XXXX',
    'XXX.XXXX.XXX',
    'XXXX.XX.XXXX',
    'XXXXX..XXXXX',
    '.XXXXXXXXXX.',
    '.XXXXXXXXXX.',
    '..XXXXXXXX..',
    '...XXXXXX...',
    '.....XX.....',
  ],
  builder: [ // a hard hat (a nod to Bob the Builder): what it takes to ship
    '............',
    '............',
    '............',
    '....XXXX....',
    '..XX.XX.XX..',
    '.XXX.XX.XXX.',
    '.XXX.XX.XXX.',
    '.XXX.XX.XXX.',
    'XXXXXXXXXXXX',
    'XXXXXXXXXXXX',
    '............',
    '............',
  ],
  contrarian: [ // a reverse card: the stance the others are least likely to take
    '.XXXXXXXXXX.',
    '.X........X.',
    '.X.....X..X.',
    '.X.XXXXXX.X.',
    '.X.....X..X.',
    '.X........X.',
    '.X........X.',
    '.X..X.....X.',
    '.X.XXXXXX.X.',
    '.X..X.....X.',
    '.X........X.',
    '.XXXXXXXXXX.',
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
  chairman: [ // a judge's gavel with a cross on its head (a nod to Higuruma's): writes the verdict; the human decides
    'XXXXXXX.....',
    '.XXXXX......',
    '.XX.XX.....X',
    '.X...XXXXXXX',
    '.XX.XXXXXXXX',
    '.XXXXX.....X',
    '.XXXXX......',
    'XXXXXXX.....',
    '............',
    'XXXXXXXX....',
    'XXXXXXXX....',
    '............',
  ],
  // the searcher: an eye looking through a magnifier. It is the court's investigator: it looks
  // for evidence before the trial, and it reads; it never argues or votes.
  searcher: [
    '...XXXX.....',
    '.XX....XX...',
    '.X.XXXX.X...',
    'X.X.XX.X.X..',
    'X.X.XX.X.X..',
    'X..XXXX..X..',
    '.X......X...',
    '.XX....XXX..',
    '...XXXX.XXX.',
    '.........XXX',
    '..........XX',
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
export function avatar(name, rows = ART[name] || ART.grill) {
  const rects = pixelRects(rows);
  return `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" fill="currentColor" aria-hidden="true">${rects}</svg>`;
}
