// The session cue: a pixel gavel that strikes once when a session opens and once when it ends,
// with a few chips, a 1px shake and a short synthesized sound. It never gates a request, changes
// review state or loads media. Replayed history never plays (ceremonyOutcome in review-view.js).
import { pixelRects, sprite } from '/ui/avatars.js';
import { playCue } from '/ui/sound.js';

// The chairman seat's own 12x12 gavel, so the pop-up and the card show one drawing. Rows 0-7
// are the gavel, rows 9-10 the block it strikes. Swing frames are redrawn on a grid twice as
// fine (nearest cell), not rotated by CSS, so every frame stays crisp. The pivot is the end of
// the handle; positive degrees lift the head, negative drop it onto the block.
const ART = sprite('chairman');
const GAVEL = ART.map((row, y) => (y <= 7 ? row : ''));
const BLOCK = ART.map((row, y) => (y >= 9 ? row : ''));
const FINE = 2, SIZE = 12 * FINE, PAD = 3, PIVOT = [11.5 * FINE, 7.5 * FINE]; // PAD: headroom for the lifted head
function rotated(rows, deg) {
  const r = (deg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r), [px, py] = PIVOT;
  return Array.from({ length: SIZE + PAD }, (_, i) => Array.from({ length: SIZE }, (_, x) => {
    const y = i - PAD, dx = x + 0.5 - px, dy = y + 0.5 - py;
    const sx = px + dx * cos + dy * sin, sy = py - dx * sin + dy * cos;
    return rows[Math.floor(sy / FINE)]?.[Math.floor(sx / FINE)] === 'X' ? 'X' : '.';
  }).join(''));
}
const scaled = (rows) => [...Array(PAD).fill(''), ...rows.flatMap((row) => { const r = [...row].map((c) => c.repeat(FINE)).join(''); return Array(FINE).fill(r); })];
const ANGLES = [0, 8, 16, -14, 4]; // rest, lifted, high, struck, bounce

// [ms after play, frame]. The strike lands on frame 0 at HIT_MS, where the sound's knock is.
const HIT_MS = 505;
const SHOW_MS = 2000;
const SWING = [[120, 1], [190, 2], [455, 1], [HIT_MS, 3], [600, 4], [680, 0]];
const TAP = [[150, 1], [HIT_MS, 3], [620, 0]];

const PHASES = {
  open: { label: 'Session open', text: 'Independent replies first.', chips: [[-2, -2], [2, -3]] },
  verdict: { label: 'Verdict ready', text: 'The verdict is ready to review.', chips: [[-3, -3], [-2, -5], [-4, -1], [2, -4], [3, -2], [1, -5]] },
  cancelled: { label: 'Review stopped', text: 'Calls cancelled. Saved replies are kept.', chips: [] },
  ended: { label: 'Session closed', text: 'Replies saved. No verdict was written.', chips: [[-3, -2], [-2, -4], [2, -3], [3, -1]] },
  failed: { label: 'Session failed', text: 'It did not finish. The board shows what happened.', chips: [[-2, 2], [-1, 3], [2, 2]] },
};

export function installCeremony() {
  const notice = document.createElement('div');
  notice.className = 'session-ceremony'; notice.hidden = true;
  notice.setAttribute('aria-hidden', 'true'); // The board's status already announces the step.
  notice.innerHTML = `<div class="ceremony-card">
    <svg class="ceremony-art" viewBox="0 0 ${SIZE} ${SIZE + PAD}" shape-rendering="crispEdges" focusable="false" aria-hidden="true">
      <g class="ceremony-block">${pixelRects(scaled(BLOCK))}</g>
      <g class="ceremony-gavel">${ANGLES.map((deg, i) => `<g${i ? ' hidden' : ''}>${pixelRects(deg ? rotated(GAVEL, deg) : scaled(GAVEL))}</g>`).join('')}</g>
      <g class="ceremony-chips"></g>
    </svg>
    <div class="ceremony-text"><strong></strong><span></span></div>
  </div>`;
  document.body.append(notice);
  const chips = notice.querySelector('.ceremony-chips');
  const frames = [...notice.querySelector('.ceremony-gavel').children];
  const show = (n) => frames.forEach((g, i) => g.toggleAttribute('hidden', i !== n));
  let timers = [];

  function cancel() {
    timers.forEach(clearTimeout); timers = [];
    notice.hidden = true; notice.classList.remove('is-playing'); chips.replaceChildren(); show(0);
  }

  function play(kind) {
    const phase = PHASES[kind];
    if (!phase) return;
    cancel();
    playCue(kind, HIT_MS / 1000); // sound follows the Sound toggle, even in a background tab
    if (document.hidden) return; // nobody would see it; the sound already told them
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    notice.dataset.phase = kind;
    notice.querySelector('strong').textContent = phase.label;
    notice.querySelector('span').textContent = phase.text;
    if (!still) {
      // Chips leave from the block where the head lands and fly away from it, one art pixel each.
      chips.innerHTML = phase.chips.map(([dx, dy]) => `<rect class="ceremony-chip" x="${dx < 0 ? 2 : 12}" y="${16 + PAD}" width="${FINE}" height="${FINE}" style="--dx:${dx}px;--dy:${dy}px"/>`).join('');
      for (const [ms, n] of kind === 'open' ? TAP : SWING) timers.push(setTimeout(show, ms, n));
    }
    notice.hidden = false;
    void notice.offsetWidth; // restart the animation if it was mid-play
    notice.classList.add('is-playing');
    timers.push(setTimeout(cancel, SHOW_MS));
  }

  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') cancel(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  return { play, cancel };
}
