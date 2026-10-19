// Synthesised footsteps (no audio files): a soft heel thump + a short filtered scuff.
// Oak parquet sounds warmer/duller, ceramic tiles brighter and clickier.
let ctx = null, noise = null
function init() {
  if (ctx) return ctx
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  ctx = new AC()
  const len = Math.floor(ctx.sampleRate * 0.25)
  noise = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = noise.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  return ctx
}
export function unlockAudio() { const c = init(); if (c && c.state === 'suspended') c.resume() }

export function footstep(surface = 'wood', volume = 0.5) {
  const c = init(); if (!c || c.state !== 'running') return
  const t = c.currentTime + 0.005
  const tile = surface === 'tile'
  const v = volume * (0.8 + Math.random() * 0.4)
  // heel thump
  const o = c.createOscillator(), og = c.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(tile ? 150 : 95, t)
  o.frequency.exponentialRampToValueAtTime(tile ? 70 : 45, t + 0.09)
  og.gain.setValueAtTime(0.0001, t)
  og.gain.exponentialRampToValueAtTime(0.55 * v, t + 0.006)
  og.gain.exponentialRampToValueAtTime(0.0001, t + (tile ? 0.08 : 0.12))
  o.connect(og).connect(c.destination)
  o.start(t); o.stop(t + 0.15)
  // scuff / click
  const n = c.createBufferSource(); n.buffer = noise; n.playbackRate.value = 0.8 + Math.random() * 0.4
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = tile ? 2600 + Math.random() * 600 : 900 + Math.random() * 300; bp.Q.value = tile ? 1.4 : 0.8
  const ng = c.createGain()
  ng.gain.setValueAtTime(0.0001, t + 0.012)
  ng.gain.exponentialRampToValueAtTime((tile ? 0.35 : 0.18) * v, t + 0.02)
  ng.gain.exponentialRampToValueAtTime(0.0001, t + (tile ? 0.06 : 0.1))
  n.connect(bp).connect(ng).connect(c.destination)
  n.start(t + 0.012); n.stop(t + 0.2)
}
