// The searcher at work: its eye moves down a column of search results, and the results it keeps
// light up. Shown in the sources panel while the research call runs. Frames are swapped by a
// timer, never tweened, so every pixel stays crisp; with reduced motion the column is shown read,
// the eye at rest beside the last result. It draws nothing but the picture: the panel text, the
// status line and the review state carry the words.
import { pixelRects, sprite } from '/ui/avatars.js';

const EYE = sprite('searcher'); // 12x12; its iris is rows 4 to 7
const IRIS = 5; // the eye's sprite row that sits level with the result it reads
const SIZE = 36; // art pixels, square
const ROWS = [[16, 7, 14, true], [16, 12, 10, false], [16, 17, 16, true], [16, 22, 12, true], [16, 27, 9, false]]; // x, y, length, kept
const TOP = ROWS[0][1] - IRIS, BOTTOM = ROWS.at(-1)[1] - IRIS;
const TICK_MS = 120, REST_TICKS = 10; // a pause with every result read before a fresh search

export function scanMarkup() {
  return `<div class="scan" role="img" aria-label="The searcher is reading search results">
    <svg class="scan-art" viewBox="0 0 ${SIZE} ${SIZE}" shape-rendering="crispEdges" focusable="false" aria-hidden="true">
      <g class="scan-results"></g>
      <g class="scan-eye">${pixelRects(EYE)}</g>
    </svg>
  </div>`;
}

// Draw the column with the eye's top at art row `y`: results above its iris are read, and the
// kept ones are lit. Each result is a square mark and a line, like a link and its title.
function frame(root, y) {
  const level = y + IRIS;
  root.querySelector('.scan-results').innerHTML = ROWS.map(([x, ry, len, kept]) => {
    const cls = ry > level ? 'scan-unread' : kept ? 'scan-kept' : 'scan-read';
    return `<g class="${cls}"><rect x="${x}" y="${ry - 1}" width="2" height="2"/><rect x="${x + 4}" y="${ry}" width="${len}" height="1"/></g>`;
  }).join('');
  root.querySelector('.scan-eye').setAttribute('transform', `translate(1 ${y})`);
}

let timer = null, playing = null;

// Start the drawing inside `root` (an element holding the markup above). Idempotent for the
// same root, so a redraw of the panel on every event does not restart the eye.
export function startScan(root) {
  if (playing === root) return;
  stopScan();
  playing = root;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { frame(root, BOTTOM); return; }
  let y = TOP, rest = 0;
  frame(root, y);
  timer = setInterval(() => {
    if (!root.isConnected) return stopScan();
    if (y >= BOTTOM) { if (++rest > REST_TICKS) { y = TOP; rest = 0; } else return; }
    else y += 1;
    frame(root, y);
  }, TICK_MS);
}

export function stopScan() {
  if (timer) clearInterval(timer);
  timer = null; playing = null;
}
