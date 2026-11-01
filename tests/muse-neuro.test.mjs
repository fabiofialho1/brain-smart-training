import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestChannels, std, percentile, movementLevel, channelFeatures, Baseline, computeScore,
  RewardController, Rocket,
} from '../js/neuro.js';

test('suggestChannels uses every good channel and suggests ignoring the bad ones', () => {
  assert.deepEqual(suggestChannels(['good', 'good', 'good', 'good']), { use: [0, 1, 2, 3], ignore: [], mode: 'alpha' });
  assert.deepEqual(suggestChannels(['noisy', 'good', 'good', 'good']), { use: [1, 2, 3], ignore: [0], mode: 'alpha' });
  assert.deepEqual(suggestChannels(['noisy', 'good', 'good', 'flat']), { use: [1, 2], ignore: [0, 3], mode: 'relax' });
  assert.deepEqual(suggestChannels(['noisy', null, 'flat', 'noisy']), { use: [], ignore: [0, 1, 2, 3], mode: 'none' });
});

test('std, percentile and movementLevel', () => {
  assert.equal(std([2, 2, 2]), 0);
  assert.ok(Math.abs(std([1, 3]) - 1) < 1e-12);
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([1, 2, 3, 4], 25), 1.75);
  assert.equal(movementLevel([1, 1, 1, 1]), 0);
  assert.ok(movementLevel([1, 1.2, 0.8, 1.1]) > 0.1);
});

test('channelFeatures: relative alpha and muscle noise', () => {
  const f = channelFeatures({ powers: [10, 10, 20, 5, 5], hfDb: -2 });
  assert.ok(Math.abs(f.alphaRel - 0.4) < 1e-12);
  assert.equal(f.emg, -2);
});

function makeBaseline() {
  const b = new Baseline(4);
  // Channel 0 (posterior): alphaRel varies around 0.2; channel 1 (forehead): emg around 5 dB.
  for (let i = 0; i < 40; i++) {
    const wiggle = (i % 5 - 2) * 0.01;
    b.add([{ alphaRel: 0.2 + wiggle, emg: 0 + wiggle * 20 }, { alphaRel: 0.15, emg: 5 + wiggle * 50 }, null, null], 0.005 + (i % 3) * 0.001);
  }
  b.finalize();
  return b;
}

test('Baseline: robust z-score statistics; channels without data are not ready', () => {
  const b = makeBaseline();
  assert.deepEqual(b.ready, [true, true, false, false]);
  assert.ok(Math.abs(b.stats.channels[0].alphaRel.m - 0.2) < 0.011);
  assert.ok(b.stats.channels[0].alphaRel.s >= 0.02);
});

test('computeScore rewards more alpha behind the ears and penalizes tension and movement', () => {
  const b = makeBaseline();
  const base = { states: ['good', 'good', null, null], used: [0, 1], mode: 'alpha', baseline: b, movement: 0.005 };
  const calm = computeScore({ ...base, features: [{ alphaRel: 0.3, emg: 0 }, { alphaRel: 0.15, emg: 5 }, null, null] });
  const rest = computeScore({ ...base, features: [{ alphaRel: 0.2, emg: 0 }, { alphaRel: 0.15, emg: 5 }, null, null] });
  const tense = computeScore({ ...base, features: [{ alphaRel: 0.3, emg: 0 }, { alphaRel: 0.15, emg: 20 }, null, null] });
  const moving = computeScore({ ...base, movement: 0.05, features: [{ alphaRel: 0.3, emg: 0 }, { alphaRel: 0.15, emg: 5 }, null, null] });
  assert.ok(calm > rest, 'more alpha scores higher');
  assert.ok(tense < calm, 'forehead tension lowers the score');
  assert.ok(moving < calm, 'movement lowers the score');
});

test('computeScore pauses (null) when there is no usable channel or the head moves a lot', () => {
  const b = makeBaseline();
  const features = [{ alphaRel: 0.3, emg: 0 }, { alphaRel: 0.15, emg: 5 }, null, null];
  const args = { features, states: ['noisy', 'good', null, null], used: [0, 1], mode: 'alpha', baseline: b, movement: 0.005 };
  assert.equal(computeScore(args), null, 'alpha mode needs a good posterior channel right now');
  assert.equal(computeScore({ ...args, states: ['good', 'good', null, null], movement: 0.5 }), null, 'too much movement');
  assert.equal(computeScore({ ...args, mode: 'none' }), null);
});

test('computeScore in relax mode: less muscle tension than baseline is rewarded', () => {
  const b = makeBaseline();
  const args = { states: [null, 'good', null, null], used: [1], mode: 'relax', baseline: b, movement: 0.005 };
  const relaxed = computeScore({ ...args, features: [null, { alphaRel: 0.15, emg: 0 }, null, null] });
  const tense = computeScore({ ...args, features: [null, { alphaRel: 0.15, emg: 12 }, null, null] });
  assert.ok(relaxed > tense);
});

test('RewardController keeps the reward rate near the target', () => {
  const rc = new RewardController({ target: 0.65 });
  let wins = 0;
  let n = 0;
  for (let i = 0; i < 600; i++) {
    const score = Math.sin(i / 7) * 2 + (i % 4) * 0.3; // arbitrary wandering score
    const { level } = rc.update(score);
    if (i >= 200) { n++; if (level > 0.5) wins++; }
  }
  assert.ok(wins / n > 0.5 && wins / n < 0.8, `reward rate ${wins / n}`);
});

test('Rocket climbs with high level, sinks slowly with low level and completes missions', () => {
  const r = new Rocket();
  r.step(0.9, 10);
  assert.ok(r.altitude > 0.1);
  const up = r.altitude;
  r.step(0.1, 10);
  assert.ok(r.altitude < up);
  r.step(0.0, 1000);
  assert.equal(r.altitude, 0, 'never below the ground');
  let missions = 0;
  for (let i = 0; i < 400; i++) if (r.step(1, 1) === 'mission') missions++;
  assert.ok(missions >= 5, `missions=${missions}`);
  assert.equal(r.missions, missions);
});
