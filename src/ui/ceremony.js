// A browser-only cue. It never gates a request, changes review state or loads media.
export function installCeremony() {
  const notice = document.createElement('div');
  notice.className = 'session-ceremony'; notice.hidden = true;
  notice.setAttribute('aria-hidden', 'true'); // The board's status already announces the step.
  notice.innerHTML = `<svg viewBox="0 0 80 80" focusable="false" aria-hidden="true">
    <path class="session-bench" d="M16 65h48M21 59h38v6H21z"/>
    <g class="session-gavel"><path d="m33 30 24 24 6-6-24-24z"/><rect x="17" y="15" width="31" height="17" rx="3" transform="rotate(-45 32.5 23.5)"/><path d="m17 27 12 12M36 8l12 12"/></g>
    <path class="session-tap" d="M64 56l5-4M67 62h6M60 54l1-6"/>
  </svg><div><strong></strong><span></span></div>`;
  document.body.append(notice);
  let timer;
  function cancel() { clearTimeout(timer); notice.hidden = true; notice.classList.remove('is-playing'); }
  function play(kind, { verdictReady = false } = {}) {
    cancel();
    if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    notice.dataset.phase = kind;
    notice.querySelector('strong').textContent = kind === 'open' ? 'Session opened' : 'Session closed';
    notice.querySelector('span').textContent = kind === 'open' ? 'Independent replies first.' : verdictReady ? 'The verdict is ready to review.' : 'Replies saved. No verdict was completed.';
    notice.hidden = false;
    // Restart only this small animation; the board and provider calls keep running.
    void notice.offsetWidth;
    notice.classList.add('is-playing');
    timer = setTimeout(cancel, 1750);
  }
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') cancel(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  return { play, cancel };
}
