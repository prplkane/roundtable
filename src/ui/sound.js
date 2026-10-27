// Short chiptune cues, synthesized on the spot: no audio files, nothing fetched. A triangle
// voice keeps the notes soft, a filtered noise burst is the gavel's knock, and everything runs
// through one quiet master gain. Browsers allow audio only after a gesture on the page, so
// unlock() is called from clicks; without one a cue stays silent instead of failing.
const KEY = 'roundtable.sound';
let ctx = null, master = null;
let enabled = true;
try { enabled = localStorage.getItem(KEY) !== 'off'; } catch {}

export const soundEnabled = () => enabled;
export function setSound(on) {
  enabled = !!on;
  try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); } catch {}
  if (enabled) unlock();
}

export function unlock() {
  if (!enabled) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(at, freq, dur, { to = freq, type = 'triangle', gain = 0.05, lowpass = 0 } = {}) {
  const osc = ctx.createOscillator(), env = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (to !== freq) osc.frequency.exponentialRampToValueAtTime(to, at + dur);
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(gain, at + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  let out = osc;
  if (lowpass) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lowpass; osc.connect(f); out = f; }
  out.connect(env); env.connect(master);
  osc.start(at); osc.stop(at + dur + 0.02);
}

let noiseBuffer = null;
function knock(at, { gain = 0.1, freq = 1700, body = 200 } = {}) {
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.05), ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  }
  const src = ctx.createBufferSource(), band = ctx.createBiquadFilter(), env = ctx.createGain();
  src.buffer = noiseBuffer;
  band.type = 'bandpass'; band.frequency.value = freq; band.Q.value = 1.4;
  env.gain.setValueAtTime(gain, at); env.gain.exponentialRampToValueAtTime(0.0001, at + 0.045);
  src.connect(band); band.connect(env); env.connect(master);
  src.start(at); src.stop(at + 0.05);
  tone(at, body, 0.07, { to: body / 2, gain: gain * 0.7 }); // the wooden body under the click
}

// hit: seconds after now when the gavel lands, matched to the animation's strike frame.
const CUES = {
  open(t) { knock(t, { gain: 0.06 }); tone(t + 0.05, 523.25, 0.09, { gain: 0.035 }); tone(t + 0.14, 783.99, 0.14, { gain: 0.035 }); },
  verdict(t) { knock(t); [523.25, 659.25, 783.99].forEach((f, i) => tone(t + 0.08 + i * 0.075, f, 0.09, { gain: 0.035 })); tone(t + 0.31, 1046.5, 0.26, { gain: 0.03 }); },
  ended(t) { knock(t, { gain: 0.08 }); tone(t + 0.08, 783.99, 0.1, { gain: 0.032 }); tone(t + 0.19, 523.25, 0.22, { gain: 0.032 }); },
  cancelled(t) { tone(t, 392, 0.1, { gain: 0.025 }); tone(t + 0.12, 261.63, 0.16, { gain: 0.025 }); },
  failed(t) { knock(t, { gain: 0.07, freq: 700, body: 140 }); tone(t + 0.07, 311.13, 0.16, { type: 'square', gain: 0.022, lowpass: 1100 }); tone(t + 0.25, 233.08, 0.3, { type: 'square', gain: 0.022, lowpass: 900, to: 220 }); },
};

export function playCue(kind, hit = 0) {
  if (!enabled || !CUES[kind]) return;
  const ac = unlock();
  if (!ac) return;
  const schedule = () => { try { CUES[kind](ac.currentTime + hit); } catch {} }; // a cue never breaks the board
  if (ac.state === 'running') return schedule();
  // Still waking up: play if it resumes at once. A late resume (the next click, minutes on) would
  // be a stale cue, so it is dropped.
  const asked = performance.now();
  ac.resume().then(() => { if (ac.state === 'running' && performance.now() - asked < 300) schedule(); }, () => {});
}
