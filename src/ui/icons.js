// Header glyphs: 12x12 pixel icons for the controls that need no word. They share the avatars'
// drawing helper so a header icon, a seat avatar and the session gavel read as one family.
import { pixelRects } from '/ui/avatars.js';

const ART = {
  sun: [
    '......X.....',
    '..X...X...X.',
    '...X.....X..',
    '.....XXX....',
    '....XXXXX...',
    '.XX.XXXXX.XX',
    '....XXXXX...',
    '.....XXX....',
    '...X.....X..',
    '..X...X...X.',
    '......X.....',
    '............',
  ],
  moon: [
    '.....XXXXX..',
    '...XXXXX....',
    '..XXXX......',
    '.XXXX.......',
    '.XXXX.......',
    '.XXXX.......',
    '.XXXX.......',
    '.XXXX.......',
    '..XXXX......',
    '...XXXXX....',
    '.....XXXXX..',
    '............',
  ],
  sound: [
    '.....X......',
    '....XX..X...',
    '...XXX...X..',
    'XXXXXX.X..X.',
    'XXXXXX.X.X.X',
    'XXXXXX.X.X.X',
    'XXXXXX.X.X.X',
    'XXXXXX.X..X.',
    '...XXX...X..',
    '....XX..X...',
    '.....X......',
    '............',
  ],
  muted: [
    '.....X......',
    '....XX......',
    '...XXX..X.X.',
    'XXXXXX...X..',
    'XXXXXX..X.X.',
    'XXXXXX......',
    'XXXXXX......',
    'XXXXXX......',
    '...XXX......',
    '....XX......',
    '.....X......',
    '............',
  ],
};

export const icon = (name) => `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" fill="currentColor" aria-hidden="true" focusable="false">${pixelRects(ART[name])}</svg>`;
