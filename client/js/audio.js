// Stage 6b: WebAudio sound synthesis. One shared AudioContext, no audio files.

const VOLUME_KEY = 'audio_volume';
const MUTED_KEY = 'audio_muted';

function readVolume() {
  try {
    const raw = window.localStorage.getItem(VOLUME_KEY);
    const value = raw === null ? 0.5 : Number(raw);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
  } catch {
    return 0.5;
  }
}

function readMuted() {
  try {
    return window.localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

export class AudioSynth {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = false;
    this.volume = readVolume();
    this.muted = readMuted();
  }

  init() {
    if (this.enabled) {
      if (this.ctx?.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(this.ctx.destination);
    this.enabled = true;
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setVolume(v) {
    const value = Number(v);
    this.volume = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    try {
      window.localStorage.setItem(VOLUME_KEY, String(this.volume));
    } catch {
      // Storage can be unavailable in private mode; sound still works.
    }
    this.applyGain();
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    try {
      window.localStorage.setItem(MUTED_KEY, this.muted ? '1' : '0');
    } catch {
      // See setVolume().
    }
    this.applyGain();
  }

  toggleMuted() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  isMuted() {
    return this.muted;
  }

  applyGain() {
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  ready() {
    return this.enabled && !this.muted && this.ctx !== null && this.master !== null;
  }

  tone({ wave = 'sine', from, to = from, duration = 0.1, delay = 0, gain = 0.2 }) {
    if (!this.ready()) return;
    const start = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const amp = this.ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(from, start);
    if (to !== from) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), start + duration);
    }
    amp.gain.setValueAtTime(0.001, start);
    amp.gain.linearRampToValueAtTime(gain, start + 0.01);
    amp.gain.exponentialRampToValueAtTime(0.001, start + duration);
    osc.connect(amp).connect(this.master);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  noise({ duration = 0.1, freq = 1000, filterType = 'lowpass', gain = 0.2, delay = 0 }) {
    if (!this.ready()) return;
    const start = this.ctx.currentTime + delay;
    const frames = Math.ceil(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    const amp = this.ctx.createGain();
    amp.gain.setValueAtTime(gain, start);
    amp.gain.exponentialRampToValueAtTime(0.001, start + duration);
    source.connect(filter).connect(amp).connect(this.master);
    source.start(start);
    source.stop(start + duration);
  }

  playHit() {
    this.tone({ wave: 'square', from: 120, duration: 0.1, gain: 0.22 });
    this.noise({ duration: 0.1, freq: 900, filterType: 'bandpass', gain: 0.18 });
  }

  playMiss() {
    this.tone({ from: 400, to: 200, duration: 0.15, gain: 0.12 });
  }

  playCrit() {
    this.tone({ wave: 'square', from: 200, duration: 0.1, gain: 0.18 });
    this.tone({ wave: 'square', from: 400, duration: 0.1, delay: 0.1, gain: 0.18 });
  }

  playDeath() {
    this.noise({ duration: 0.5, freq: 180, gain: 0.3 });
    this.tone({ from: 60, duration: 0.5, gain: 0.18 });
  }

  playHeal() {
    this.tone({ from: 600, to: 800, duration: 0.3, gain: 0.14 });
  }

  playReload() {
    this.tone({ wave: 'square', from: 800, duration: 0.05, gain: 0.12 });
    this.tone({ wave: 'square', from: 800, duration: 0.05, delay: 0.09, gain: 0.12 });
  }

  playVictory() {
    for (const [i, freq] of [261, 330, 392].entries()) {
      this.tone({ from: freq, duration: 0.3, delay: i * 0.15, gain: 0.16 });
    }
  }

  playDefeat() {
    this.tone({ from: 330, duration: 0.25, gain: 0.16 });
    this.tone({ from: 261, duration: 0.25, delay: 0.25, gain: 0.16 });
  }

  playStance() {
    this.tone({ wave: 'square', from: 600, duration: 0.05, gain: 0.12 });
  }
}

export const audio = new AudioSynth();

// Browsers only allow an AudioContext after a user gesture. Arm both pointer
// and keyboard gestures once at startup; init() itself is idempotent.
export function armAudioOnGesture() {
  if (typeof document === 'undefined') return;
  const start = () => {
    audio.init();
    document.removeEventListener('pointerdown', start);
    document.removeEventListener('keydown', start);
  };
  document.addEventListener('pointerdown', start);
  document.addEventListener('keydown', start);
}
