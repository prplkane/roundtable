export const MOOD_HELP = {
  grill: 'Challenge assumptions and ask for evidence before agreeing.',
  steelman: 'Make the strongest case for each option before judging it.',
  builder: 'Focus on practical steps, effort and what could break.',
  contrarian: 'Explore the less popular position and defend it with evidence.',
  custom: 'Write your own sentence describing how this seat should argue.',
};
const HELP = {
  lens: { title: 'Lens', text: 'The perspective this seat focuses on, such as risk, evidence or long-term effects. Give each seat a different lens so the review covers more than one angle.' },
  mood: { title: 'Mood', text: 'How this seat argues. Its lens sets the topic of attention; its mood sets the approach.' },
  critique: { title: 'Critique rounds', text: 'After the first independent replies, each seat reads and responds to the others. Set 0 for initial replies and a verdict only; 1 allows one extra exchange. The review can finish early. Extra rounds use more quota.' },
  auto: { title: 'Auto-continue', text: 'How long the table waits at a timed pause before continuing. Clicking or typing requests a pause; “Countdown held” confirms it. A direct question still waits for your answer.' },
  wall: { title: 'Wall clock', text: 'The total time limit, including pauses while you read or type. When it runs out, the review stops. Give yourself enough time to respond.' },
  unattended: { title: 'Unattended', text: 'Off: the table pauses after the blind round and whenever a seat asks you something. On: it never waits for you; the pause is skipped and the seats state what they would have asked as assumptions instead of asking. For a review nobody is watching.' },
  memory: { title: 'Memory', text: 'Stateless starts a fresh call each round with the relevant notes and replies. Resume continues a growing conversation and may use more tokens. Stateless is a good starting point.' },
  isolation: { title: 'Limited isolation', text: 'Appears when Antigravity is at the table: the table will not open with it until this is allowed. Antigravity’s tool rules deny operations, but its shared customizations and MCP discovery cannot be switched off. Reported tool activity still stops the seat. Choose another provider if that is not acceptable.' },
  searchLimits: { title: 'Search limits', text: 'The search limit counts the search operations the searcher\'s CLI reports; one operation can hold several queries or page visits, and one over the limit may start before its report arrives. Claude also counts its searches at the end, and a count over the limit fails the research. The time limit stops the searcher. Sources and excerpts come from the provider and are not checked independently.' },
  effort: { title: 'Effort', text: 'How much reasoning the model should use. Higher effort can take longer and use more quota. No filled squares means the provider’s default.' },
};

// Full text is present from the start for selection and assistive technology. Only its visual
// presentation changes; this does not pretend that a completed provider reply is still running.
export function revealText(root, { startedAt = performance.now(), duration = 700 } = {}) {
  const win = root.ownerDocument.defaultView;
  if (win.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const elapsed = Math.max(0, performance.now() - startedAt);
  if (elapsed >= duration + 260) return;
  const walker = root.ownerDocument.createTreeWalker(root, win.NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.textContent.trim() && !node.parentElement.closest('.label, .sr-only, .text-reveal-word, button, select, pre, code, .verdict-meta')) nodes.push(node);
  }
  const total = nodes.reduce((n, node) => n + node.textContent.split(/\s+/u).filter(Boolean).length, 0);
  let i = 0;
  for (const node of nodes) {
    const fragment = root.ownerDocument.createDocumentFragment();
    for (const word of node.textContent.split(/(\s+)/u)) {
      if (!word || /^\s+$/u.test(word)) { fragment.append(word); continue; }
      const span = root.ownerDocument.createElement('span');
      span.className = 'text-reveal-word'; span.textContent = word;
      span.style.animationDelay = `${Math.round(i++ * duration / Math.max(1, total) - elapsed)}ms`;
      fragment.append(span);
    }
    node.replaceWith(fragment);
  }
}

export function installHelp() {
  for (const [key, value] of Object.entries(HELP)) {
    const description = document.createElement('span');
    description.id = `help-${key}`; description.className = 'sr-only'; description.textContent = value.text;
    document.body.append(description);
  }
  const bubble = document.createElement('div');
  bubble.className = 'help-popover'; bubble.setAttribute('role', 'tooltip');
  bubble.setAttribute('aria-hidden', 'true'); // controls describe the complete, non-animated text above
  document.body.append(bubble);
  let active = null, openTimer = null, closeTimer = null;
  function close() {
    clearTimeout(openTimer); clearTimeout(closeTimer);
    bubble.classList.remove('is-open'); active = null;
  }
  function position() {
    if (!active?.isConnected) { close(); return; }
    const anchor = active.getBoundingClientRect(), rect = bubble.getBoundingClientRect();
    if (anchor.bottom < 0 || anchor.top > innerHeight) { close(); return; }
    const left = Math.max(12, Math.min(anchor.left, innerWidth - rect.width - 12));
    const below = anchor.bottom + 10;
    const top = below + rect.height <= innerHeight - 12 ? below : Math.max(12, anchor.top - rect.height - 10);
    bubble.style.left = `${left}px`; bubble.style.top = `${top}px`;
  }
  function show(target) {
    clearTimeout(openTimer); clearTimeout(closeTimer);
    const help = HELP[target?.dataset.help]; if (!help || !target.isConnected) return;
    active = target;
    const title = document.createElement('strong'), text = document.createElement('p');
    title.textContent = help.title; text.textContent = help.text;
    if (target.dataset.help === 'mood') {
      const mood = target.closest('.seat')?.querySelector('.mood')?.value;
      if (MOOD_HELP[mood]) text.textContent += ` ${mood === 'custom' ? 'Custom' : mood[0].toUpperCase() + mood.slice(1)}: ${MOOD_HELP[mood]}`;
    }
    bubble.replaceChildren(title, text); position();
    bubble.classList.add('is-open'); revealText(text, { duration: 480 });
  }
  function schedule(target, delay = 900) {
    if (!HELP[target?.dataset.help]) return;
    clearTimeout(closeTimer);
    if (active === target && bubble.classList.contains('is-open')) return;
    clearTimeout(openTimer); openTimer = setTimeout(() => show(target), delay);
  }
  const leave = () => { clearTimeout(openTimer); closeTimer = setTimeout(() => { if (!active?.contains(document.activeElement)) close(); }, 160); };
  document.addEventListener('pointerover', (e) => { const target = e.target.closest('[data-help]'); if (target) schedule(target); });
  document.addEventListener('pointerout', (e) => {
    const target = e.target.closest('[data-help]');
    if (target && !target.contains(e.relatedTarget) && !bubble.contains(e.relatedTarget)) leave();
  });
  document.addEventListener('focusin', (e) => { if (e.target.matches('[data-help]')) schedule(e.target, 900); });
  document.addEventListener('focusout', (e) => { if (e.target.matches('[data-help]')) leave(); });
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-help]');
    if (trigger) {
      e.preventDefault(); // A label's forwarded input click would immediately dismiss its hint.
      const target = trigger.closest('[data-help]');
      if (active === target && bubble.classList.contains('is-open')) close(); else show(target);
    } else if (!bubble.contains(e.target) && !e.target.closest('[data-help]')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    else if (['Enter', ' '].includes(e.key) && e.target.matches('[data-help]')) {
      e.preventDefault();
      if (active === e.target && bubble.classList.contains('is-open')) close(); else show(e.target);
    }
  });
  bubble.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  bubble.addEventListener('pointerleave', leave);
  window.addEventListener('resize', () => { if (active) position(); });
  document.addEventListener('scroll', () => { if (active) position(); }, true);
  return { close };
}
