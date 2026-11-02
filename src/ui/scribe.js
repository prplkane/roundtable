// The chairman at work: a pixel sheet on which lines of text appear under a quill, shown in the
// Conclusion panel while the verdict call runs. Frames are swapped by a timer, never tweened, so
// every pixel stays crisp; with reduced motion the sheet is shown written, the quill at rest.
// It draws nothing but the picture: the status line and the review state carry the words.
import { pixelRects, sprite } from '/ui/avatars.js';

const QUILL = sprite('custom'); // the custom seat's 12x12 quill; its nib is the bottom-left pixel
const NIB = [0, 11];
const SIZE = 36; // art pixels, square
const PAGE = { x: 2, y: 9, w: 20, h: 24 };
const LINES = [[4, 13, 13], [4, 16, 15], [4, 19, 11], [4, 22, 14], [4, 25, 9], [4, 28, 12]]; // x, y, full length
const TOTAL = LINES.reduce((n, [, , len]) => n + len, 0);
const TICK_MS = 110, REST_TICKS = 9; // a pause with the page full before a fresh sheet

export function scribeMarkup() {
  return `<div class="scribe" role="img" aria-label="The chairman is writing the verdict">
    <svg class="scribe-art" viewBox="0 0 ${SIZE} ${SIZE}" shape-rendering="crispEdges" focusable="false" aria-hidden="true">
      <rect class="scribe-shadow" x="${PAGE.x + 1}" y="${PAGE.y + 1}" width="${PAGE.w}" height="${PAGE.h}"/>
      <rect class="scribe-shadow" x="${PAGE.x}" y="${PAGE.y}" width="${PAGE.w}" height="${PAGE.h}"/>
      <rect class="scribe-page" x="${PAGE.x + 1}" y="${PAGE.y + 1}" width="${PAGE.w - 2}" height="${PAGE.h - 2}"/>
      <g class="scribe-ink"></g>
      <g class="scribe-quill">${pixelRects(QUILL)}</g>
    </svg>
  </div>`;
}

// Draw the sheet with `ink` pixels written and the quill's nib on the next one.
function frame(root, ink) {
  let left = ink, nib = null;
  const rows = [];
  for (const [x, y, len] of LINES) {
    const w = Math.min(len, left);
    if (w > 0) rows.push(`<rect x="${x}" y="${y}" width="${w}" height="1"/>`);
    if (left < len) { nib = [x + Math.max(w, 0), y]; break; }
    left -= len;
  }
  if (!nib) { const [x, y, len] = LINES.at(-1); nib = [x + len, y]; }
  root.querySelector('.scribe-ink').innerHTML = rows.join('');
  root.querySelector('.scribe-quill').setAttribute('transform', `translate(${nib[0] - NIB[0]} ${nib[1] - NIB[1]})`);
}

let timer = null, playing = null;

// Start the drawing inside `root` (an element holding the markup above). Idempotent for the
// same root, so a redraw of the panel on every event does not restart the hand.
export function startScribe(root) {
  if (playing === root) return;
  stopScribe();
  playing = root;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { frame(root, TOTAL); return; }
  let ink = 0, rest = 0;
  frame(root, ink);
  timer = setInterval(() => {
    if (!root.isConnected) return stopScribe();
    if (ink >= TOTAL) { if (++rest > REST_TICKS) { ink = 0; rest = 0; } else return; }
    else ink += ink % 5 === 4 ? 2 : 1; // an uneven hand
    frame(root, ink);
  }, TICK_MS);
}

export function stopScribe() {
  if (timer) clearInterval(timer);
  timer = null; playing = null;
}
