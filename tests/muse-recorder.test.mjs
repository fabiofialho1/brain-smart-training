import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../js/recorder.js';

const rows = (rec, kind) => rec.csvParts(kind).join('').trim().split('\n');

test('EEG rows align channels by packet index', () => {
  const rec = new Recorder(0);
  for (let ch = 0; ch < 4; ch++) {
    rec.addEeg(ch, 10, Array(12).fill(ch + 1));
    rec.addEeg(ch, 11, Array(12).fill((ch + 1) * 10));
  }
  const lines = rows(rec, 'eeg');
  assert.equal(lines[0], 'time_s,TP9,AF7,AF8,TP10');
  assert.equal(lines.length, 1 + 24);
  assert.equal(lines[1], '0.0000,1,2,3,4');
  assert.equal(lines[13], `${(12 / 256).toFixed(4)},10,20,30,40`);
});

test('lost packets leave empty cells and packet index wraps at 65536', () => {
  const rec = new Recorder(0);
  rec.addEeg(0, 65534, Array(12).fill(1));
  rec.addEeg(0, 1, Array(12).fill(2)); // 65535 and 0 were lost
  const lines = rows(rec, 'eeg');
  assert.equal(lines.length, 1 + 12 * 4);
  assert.equal(lines[1].split(',')[1], '1');
  assert.equal(lines[13], `${(12 / 256).toFixed(4)},,,,`);
  assert.equal(lines[37].split(',')[1], '2');
});

test('duplicate and out-of-order packets are ignored', () => {
  const rec = new Recorder(0);
  rec.addPpg(1, 5, [1, 2, 3, 4, 5, 6]);
  rec.addPpg(1, 5, [9, 9, 9, 9, 9, 9]);
  rec.addPpg(1, 4, [8, 8, 8, 8, 8, 8]);
  const lines = rows(rec, 'ppg');
  assert.equal(lines.length, 1 + 6);
  assert.equal(lines[1], '0.0000,,1,');
});

test('motion merges accelerometer and gyroscope columns', () => {
  const rec = new Recorder(0);
  rec.addMotion('accel', 3, [[0, 0, 1], [0, 0, 1], [0, 0, 1]]);
  rec.addMotion('gyro', 3, [[1, 2, 3], [1, 2, 3], [1, 2, 3]]);
  const lines = rows(rec, 'motion');
  assert.equal(lines[0], 'time_s,acc_x_g,acc_y_g,acc_z_g,gyro_x_dps,gyro_y_dps,gyro_z_dps');
  assert.equal(lines[1], '0.0000,0,0,1,1,2,3');
});

test('restart moves the timeline forward after a reconnection', () => {
  const rec = new Recorder(1000);
  rec.addPpg(0, 100, Array(6).fill(1));
  rec.restart(1000 + 2000); // 2 s later; the device counter restarts
  rec.addPpg(0, 0, Array(6).fill(2));
  const lines = rows(rec, 'ppg');
  assert.equal(lines.length, 1 + 128 + 6);
  assert.equal(lines[1 + 128].split(',')[1], '2');
  assert.equal(lines[10], `${(9 / 64).toFixed(4)},,,`); // gap
});

test('bands CSV has one column per channel and band plus heart rate', () => {
  const rec = new Recorder(0);
  const powers = [0, 1, 2, 3].map(() => [1, 2, 3, 4, 5]);
  rec.addBands(500, powers, 71.234);
  rec.addBands(1000, powers, null);
  const lines = rows(rec, 'bands');
  assert.equal(lines[0].split(',').length, 1 + 20 + 1);
  assert.ok(lines[0].startsWith('time_s,TP9_delta_uv2,TP9_theta_uv2'));
  assert.ok(lines[1].startsWith('0.500,1,2,3,4,5'));
  assert.ok(lines[1].endsWith(',71.2'));
  assert.ok(lines[2].endsWith(','));
});

test('isEmpty reflects recorded data', () => {
  const rec = new Recorder(0);
  assert.equal(rec.isEmpty, true);
  rec.addEeg(0, 0, Array(12).fill(0));
  assert.equal(rec.isEmpty, false);
});
