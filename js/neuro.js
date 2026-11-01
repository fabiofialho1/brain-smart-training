// Neurofeedback logic for the rocket game. Pure functions, covered by tests/muse-neuro.test.mjs.
//
// Channels: 0 TP9, 1 AF7, 2 AF8, 3 TP10. Behind the ears (posterior) alpha is reactive; on the
// forehead the signal is dominated by blinks and muscle, so there we reward a relaxed face.

export const EEG_POSTERIOR = [0, 3];
export const EEG_FOREHEAD = [1, 2];

// Which channels to use: every good one; the others are suggested to be ignored.
// mode: 'alpha' (a good channel behind the ears), 'relax' (forehead only) or 'none'.
export function suggestChannels(states) {
  const use = [];
  const ignore = [];
  states.forEach((s, ch) => (s === 'good' ? use : ignore).push(ch));
  const mode = use.some((ch) => EEG_POSTERIOR.includes(ch)) ? 'alpha' : use.length > 0 ? 'relax' : 'none';
  return { use, ignore, mode };
}

export function std(values) {
  if (values.length === 0) return 0;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= values.length;
  let ss = 0;
  for (const v of values) ss += (v - mean) ** 2;
  return Math.sqrt(ss / values.length);
}

// Head movement: standard deviation of the accelerometer magnitude (g) over ~2 s.
export function movementLevel(magnitudes) {
  return std(magnitudes);
}

export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const median = (values) => percentile(values, 50);

// Features of one channel from a window: relative alpha and high-frequency (muscle) noise in dB.
// `powers` is in BANDS order (delta, theta, alpha, beta, gamma).
export function channelFeatures({ powers, hfDb }) {
  const total = powers.reduce((a, b) => a + b, 0) || 1;
  return { alphaRel: powers[2] / total, emg: hfDb };
}

// Floors keep a very quiet baseline from turning tiny wiggles into huge z-scores.
const STD_FLOOR = { alphaRel: 0.02, emg: 1, move: 0.003 };
const MIN_BASELINE_SAMPLES = 10;

// Personal baseline: median and robust spread (MAD) of each feature during the calibration.
export class Baseline {
  constructor(channels = 4) {
    this.samples = Array.from({ length: channels }, () => ({ alphaRel: [], emg: [] }));
    this.move = [];
    this.stats = null;
  }

  add(features, movement) {
    features.forEach((f, ch) => {
      if (!f) return;
      this.samples[ch].alphaRel.push(f.alphaRel);
      this.samples[ch].emg.push(f.emg);
    });
    if (movement !== null && movement !== undefined) this.move.push(movement);
  }

  finalize() {
    const robust = (values, floor) => {
      const m = median(values);
      return { m, s: Math.max(floor, 1.4826 * median(values.map((v) => Math.abs(v - m)))) };
    };
    this.stats = {
      channels: this.samples.map((s) => (s.alphaRel.length >= MIN_BASELINE_SAMPLES
        ? { alphaRel: robust(s.alphaRel, STD_FLOOR.alphaRel), emg: robust(s.emg, STD_FLOOR.emg) }
        : null)),
      move: this.move.length >= MIN_BASELINE_SAMPLES ? robust(this.move, STD_FLOOR.move) : { m: 0, s: STD_FLOOR.move },
    };
    return this.stats;
  }

  // Channels with enough calibration data.
  get ready() {
    return this.stats ? this.stats.channels.map((c) => c !== null) : [];
  }
}

const z = ({ m, s }, value) => (value - m) / s;
const MOVE_PAUSE_Z = 6; // moving much more than in the baseline: pause the game

// Calm score in z units (higher = calmer), or null when the game should pause.
// `features[ch]`: channelFeatures() or null; `states[ch]`: stable quality; `used`: chosen channels.
export function computeScore({ features, states, used, mode, movement, baseline }) {
  const st = baseline.stats;
  const usable = used.filter((ch) => states[ch] === 'good' && features[ch] && st.channels[ch]);
  const moveZ = z(st.move, movement ?? st.move.m);
  if (moveZ > MOVE_PAUSE_Z) return null;
  const movePenalty = Math.max(0, moveZ);

  if (mode === 'alpha') {
    const posterior = usable.filter((ch) => EEG_POSTERIOR.includes(ch));
    if (posterior.length === 0) return null;
    const alpha = posterior.reduce((a, ch) => a + z(st.channels[ch].alphaRel, features[ch].alphaRel), 0) / posterior.length;
    const tension = usable.reduce((a, ch) => a + Math.max(0, z(st.channels[ch].emg, features[ch].emg)), 0) / usable.length;
    return alpha - 0.5 * tension - 0.5 * movePenalty;
  }
  if (mode === 'relax') {
    if (usable.length === 0) return null;
    const tension = usable.reduce((a, ch) => a + z(st.channels[ch].emg, features[ch].emg), 0) / usable.length;
    return -tension - 0.7 * movePenalty;
  }
  return null;
}

// Keeps the game winnable about 65% of the time: the threshold follows the recent scores.
export class RewardController {
  constructor({ target = 0.65, window = 120, minHistory = 20, softness = 0.5 } = {}) {
    this.history = [];
    this.window = window;
    this.minHistory = minHistory;
    this.softness = softness;
    this.pct = (1 - target) * 100;
  }

  update(score) {
    this.history.push(score);
    if (this.history.length > this.window) this.history.shift();
    const threshold = this.history.length >= this.minHistory ? percentile(this.history, this.pct) : 0;
    const level = 1 / (1 + Math.exp(-(score - threshold) / this.softness));
    return { level, threshold };
  }
}

// The rocket climbs while the level is above 0.4 and sinks slowly below; reaching the top
// completes a mission and starts again from the ground.
export class Rocket {
  constructor() {
    this.altitude = 0;
    this.missions = 0;
  }

  step(level, dt) {
    const rate = level >= 0.4 ? 0.05 : 0.03;
    this.altitude = Math.max(0, this.altitude + (level - 0.4) * rate * dt);
    if (this.altitude >= 1) {
      this.altitude = 0;
      this.missions++;
      return 'mission';
    }
    return null;
  }
}
