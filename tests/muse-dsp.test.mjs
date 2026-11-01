import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RingBuffer, fft, powerSpectrum, bandPowers, bandDensityDb, groupBandDb, BandAccumulator, BANDS, Biquad, FilterChain, analyzeWindow,
  estimateHeartRate, HR_MIN_SNR,
} from '../js/dsp.js';

const sine = (n, fs, f, amp = 1, phase = 0) =>
  Float64Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * f * (i / fs) + phase));

// Deterministic pseudo-random noise in [-1, 1].
function noise(n, seed = 1) {
  let s = seed;
  return Float64Array.from({ length: n }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  });
}

test('RingBuffer keeps the newest samples in order', () => {
  const r = new RingBuffer(4);
  r.pushMany([1, 2, 3]);
  assert.deepEqual([...r.toArray()], [1, 2, 3]);
  r.pushMany([4, 5, 6]);
  assert.deepEqual([...r.toArray()], [3, 4, 5, 6]);
  assert.deepEqual([...r.toArray(2)], [5, 6]);
});

test('fft matches a naive DFT', () => {
  const n = 16;
  const x = noise(n, 3);
  const re = Float64Array.from(x);
  const im = new Float64Array(n);
  fft(re, im);
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      sr += x[t] * Math.cos((2 * Math.PI * k * t) / n);
      si -= x[t] * Math.sin((2 * Math.PI * k * t) / n);
    }
    assert.ok(Math.abs(re[k] - sr) < 1e-9 && Math.abs(im[k] - si) < 1e-9);
  }
  assert.throws(() => fft(new Float64Array(6), new Float64Array(6)));
});

test('power spectrum preserves signal power (Parseval)', () => {
  const x = sine(512, 256, 10, 10); // power A²/2 = 50 µV²
  const { psd, df } = powerSpectrum(x, 256);
  const total = psd.reduce((a, v) => a + v * df, 0);
  assert.ok(Math.abs(total - 50) / 50 < 0.02, `total=${total}`);
});

test('bandPowers puts a sine in the right band', () => {
  const idx = (hz) => BANDS.findIndex((b) => hz >= b.lo && hz < b.hi);
  for (const hz of [2, 6, 10, 20, 38]) {
    const p = bandPowers(sine(512, 256, hz, 10), 256);
    const best = p.indexOf(Math.max(...p));
    assert.equal(best, idx(hz), `${hz} Hz`);
    assert.ok(p[best] > 40 && p[best] < 52, `${hz} Hz power ${p[best]}`);
  }
});

test('bandPowers ignores a large DC offset and drift', () => {
  const x = sine(512, 256, 10, 10).map((v, i) => v + 800 + i * 0.5);
  const p = bandPowers(x, 256);
  assert.ok(p[2] > 40);
  assert.ok(p[0] < 1);
});

test('Biquad low-pass removes high frequencies, high-pass removes DC', () => {
  const lp = Biquad.lowpass(256, 20);
  const out = sine(1024, 256, 100).map((v) => lp.process(v));
  assert.ok(Math.max(...out.slice(512).map(Math.abs)) < 0.05);

  const chain = new FilterChain([Biquad.highpass(256, 1)]);
  const dc = Array.from({ length: 200 }, () => chain.process(900));
  assert.ok(dc.every((v) => Math.abs(v) < 1e-6), 'primed filter has no start-up transient');
});

test('alpha band starts at 7.5 Hz and density is power per Hz', () => {
  const alpha = BANDS.find((b) => b.id === 'alpha');
  assert.equal(alpha.lo, 7.5);
  const p = bandPowers(sine(512, 256, 7.5, 10), 256);
  assert.equal(p.indexOf(Math.max(...p)), 2);
  // 52 µV² spread over 5.5 Hz of alpha -> 10*log10(52/5.5) dB
  assert.ok(Math.abs(bandDensityDb(52, alpha) - 10 * Math.log10(52 / 5.5)) < 1e-9);
});

test('analyzeWindow returns band powers and classifies flat, good and noisy channels', () => {
  const eeg = (amp) => sine(512, 256, 10, amp).map((v, i) => v + 5 * noise(512, 2)[i]);
  assert.equal(analyzeWindow(new Float64Array(512), 256).quality.state, 'flat');

  const good = analyzeWindow(eeg(20), 256);
  assert.equal(good.quality.state, 'good');
  assert.equal(good.powers.length, BANDS.length);
  assert.ok(good.quality.hfDb < 5);

  // Large movement artifact: rms above 100 µV.
  assert.equal(analyzeWindow(eeg(400), 256).quality.state, 'noisy');

  // Broadband noise (badly seated electrode): rms is plausible (~50 µV) but the 55-100 Hz
  // density is far above real EEG.
  const broadband = Float64Array.from(noise(512, 7), (v) => v * 80);
  const bb = analyzeWindow(broadband, 256);
  assert.ok(bb.quality.rms < 100, `rms=${bb.quality.rms}`);
  assert.ok(bb.quality.hfDb > 5, `hf=${bb.quality.hfDb}`);
  assert.equal(bb.quality.state, 'noisy');
});

test('estimateHeartRate finds the pulse of a synthetic PPG', () => {
  const fs = 64;
  const n = fs * 10;
  const pulse = (f) => sine(n, fs, f, 1000).map((v, i) => v + 300 * Math.sin(2 * Math.PI * 2 * f * (i / fs)) + 100 * noise(n, 5)[i]);
  for (const bpm of [48, 72, 95, 130]) {
    const r = estimateHeartRate(pulse(bpm / 60).map((v) => v + 50000), fs);
    assert.ok(Math.abs(r.bpm - bpm) < 1.5, `${bpm} -> ${r.bpm}`);
    assert.ok(r.snr >= HR_MIN_SNR);
  }
});

test('estimateHeartRate reports a low SNR for pure noise and null for short input', () => {
  const r = estimateHeartRate(noise(640, 9), 64);
  assert.ok(r.snr < HR_MIN_SNR, `snr=${r.snr}`);
  assert.equal(estimateHeartRate(noise(100, 9), 64), null);
});

test('groupBandDb averages channels and reports dB of density', () => {
  const delta = BANDS[0]; // 1-4 Hz, 3 Hz wide
  const db = groupBandDb([[30, 0, 0, 0, 0], [60, 0, 0, 0, 0]], BANDS);
  assert.ok(Math.abs(db[0] - 10 * Math.log10(45 / 3)) < 1e-9);
  assert.equal(delta.hi - delta.lo, 3);
  assert.ok(db[1] < -100); // empty band does not produce NaN
});

test('BandAccumulator averages clean channels and drops any channel with a bad window', () => {
  const acc = new BandAccumulator(3);
  acc.add(0, [10, 0, 0, 0, 0], 'good');
  acc.add(0, [30, 0, 0, 0, 0], 'good');
  acc.add(1, [20, 0, 0, 0, 0], 'good');
  acc.add(1, [1000, 0, 0, 0, 0], 'noisy'); // edge of an artifact: whole channel dropped
  acc.add(2, [500, 0, 0, 0, 0], 'noisy'); // never good
  const db = acc.flush();
  assert.ok(Math.abs(db[0] - 10 * Math.log10(20 / 3)) < 1e-9); // only channel 0: mean(10, 30)
  assert.equal(acc.flush(), null);
});

test('BandAccumulator returns null when no channel had a good window (artifact)', () => {
  const acc = new BandAccumulator(2);
  acc.add(0, [1e5, 1e5, 1e5, 1e5, 1e5], 'noisy');
  acc.add(1, [60, 0, 0, 0, 0], 'flat');
  assert.equal(acc.flush(), null);
  // and it is clean for the next interval
  acc.add(0, [30, 0, 0, 0, 0], 'good');
  assert.ok(acc.flush() !== null);
});
