// Signal processing: ring buffers, FFT, band power, filters, heart rate.
// Pure logic; covered by tests/muse-dsp.test.mjs.

export class RingBuffer {
  constructor(size) {
    this.size = size;
    this.buf = new Float32Array(size);
    this.head = 0; // next write position
    this.count = 0;
  }

  push(v) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.size;
    if (this.count < this.size) this.count++;
  }

  pushMany(values) {
    for (const v of values) this.push(v);
  }

  // Last `n` samples, oldest first.
  toArray(n = this.count) {
    n = Math.min(n, this.count);
    const out = new Float32Array(n);
    let pos = (this.head - n + this.size) % this.size;
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[pos];
      pos = (pos + 1) % this.size;
    }
    return out;
  }
}

// In-place iterative radix-2 FFT.
export function fft(re, im) {
  const n = re.length;
  if (n & (n - 1)) throw new Error('FFT length must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

// Subtracts the least-squares line (removes DC offset and slow drift).
export function detrend(x) {
  const n = x.length;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += x[i];
    sxy += i * x[i];
    sxx += i * i;
  }
  const den = n * sxx - sx * sx;
  const slope = den === 0 ? 0 : (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = x[i] - (intercept + slope * i);
  return out;
}

// One-sided power spectral density (units²/Hz) of `samples` (Hann window,
// detrended). `nfft` > length zero-pads, for a finer frequency grid.
export function powerSpectrum(samples, fs, nfft = samples.length) {
  const n = samples.length;
  const x = detrend(samples);
  const w = hann(n);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    re[i] = x[i] * w[i];
    s2 += w[i] * w[i];
  }
  fft(re, im);
  const half = nfft / 2;
  const psd = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    const p = (re[k] * re[k] + im[k] * im[k]) / (fs * s2);
    psd[k] = k === 0 || k === half ? p : 2 * p;
  }
  return { psd, df: fs / nfft };
}

// Power (units²) in [lo, hi) Hz.
export function bandPower({ psd, df }, lo, hi) {
  const first = Math.ceil(lo / df - 1e-9);
  const last = Math.ceil(hi / df - 1e-9); // exclusive
  let sum = 0;
  for (let k = first; k < last && k < psd.length; k++) sum += psd[k] * df;
  return sum;
}

// Delta starts at 1 Hz: slower drift is not brain activity. Gamma stops at 44 Hz
// to stay clear of the 50 Hz mains interference.
export const BANDS = [
  { id: 'delta', lo: 1, hi: 4 },
  { id: 'theta', lo: 4, hi: 8 },
  { id: 'alpha', lo: 8, hi: 13 },
  { id: 'beta', lo: 13, hi: 30 },
  { id: 'gamma', lo: 30, hi: 44 },
];

// Power of every band (in BANDS order, µV²) for one EEG window (~2 s = 512 samples).
export function bandPowers(samples, fs) {
  const spec = powerSpectrum(samples, fs);
  return BANDS.map((b) => bandPower(spec, b.lo, b.hi));
}

// --- Filters (RBJ cookbook biquads, transposed direct form II) ---

export class Biquad {
  constructor(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    this.z1 = 0;
    this.z2 = 0;
  }

  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  get dcGain() {
    return (this.b0 + this.b1 + this.b2) / (1 + this.a1 + this.a2);
  }

  // Sets the state as if the input had been constant `x` forever (no start-up transient).
  prime(x) {
    const y = this.dcGain * x;
    this.z1 = y - this.b0 * x;
    this.z2 = this.b2 * x - this.a2 * y;
  }

  static lowpass(fs, fc, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * fc) / fs;
    const c = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    return new Biquad((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha);
  }

  static highpass(fs, fc, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * fc) / fs;
    const c = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    return new Biquad((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
  }
}

export class FilterChain {
  constructor(filters) {
    this.filters = filters;
    this.primed = false;
  }

  process(x) {
    if (!this.primed) {
      let v = x;
      for (const f of this.filters) {
        f.prime(v);
        v *= f.dcGain;
      }
      this.primed = true;
    }
    let v = x;
    for (const f of this.filters) v = f.process(v);
    return v;
  }
}

// --- EEG signal quality ---

export const QUALITY_FLAT_UV = 0.3;
export const QUALITY_NOISY_UV = 100;

// `samples`: band-passed EEG (µV), ~1 s. Standard deviation decides:
// flat = no signal / no contact, noisy = movement or poor contact.
export function signalQuality(samples) {
  const n = samples.length;
  if (n === 0) return { rms: 0, state: 'flat' };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i];
  mean /= n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (samples[i] - mean) ** 2;
  const rms = Math.sqrt(ss / n);
  const state = rms < QUALITY_FLAT_UV ? 'flat' : rms > QUALITY_NOISY_UV ? 'noisy' : 'good';
  return { rms, state };
}

// --- Heart rate from PPG ---

export const HR_MIN_BPM = 40;
export const HR_MAX_BPM = 180;
export const HR_MIN_SNR = 6; // peak power / mean power of the rest of the band

// Estimates the pulse rate from ~6-10 s of PPG: spectral peak inside 40-180 bpm.
// Returns { bpm, snr } or null when there is too little data.
export function estimateHeartRate(samples, fs, nfft = 4096) {
  if (samples.length < fs * 5) return null;
  const { psd, df } = powerSpectrum(samples, fs, nfft);
  const lo = Math.ceil(HR_MIN_BPM / 60 / df);
  const hi = Math.floor(HR_MAX_BPM / 60 / df);
  let peak = lo;
  for (let k = lo; k <= hi; k++) if (psd[k] > psd[peak]) peak = k;

  // Parabolic interpolation around the peak for sub-bin accuracy.
  let offset = 0;
  if (peak > lo && peak < hi) {
    const a = psd[peak - 1];
    const b = psd[peak];
    const c = psd[peak + 1];
    const den = a - 2 * b + c;
    if (den !== 0) offset = (0.5 * (a - c)) / den;
  }
  const bpm = (peak + offset) * df * 60;

  // Noise floor: band bins farther than 0.25 Hz from the peak.
  const guard = Math.ceil(0.25 / df);
  let noise = 0;
  let count = 0;
  for (let k = lo; k <= hi; k++) {
    if (Math.abs(k - peak) > guard) {
      noise += psd[k];
      count++;
    }
  }
  const snr = count > 0 && noise > 0 ? psd[peak] / (noise / count) : 0;
  return { bpm, snr };
}
