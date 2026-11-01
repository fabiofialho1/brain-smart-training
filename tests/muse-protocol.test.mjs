import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeCommand, decodeUnsigned12Bit, decodeUnsigned24Bit, decodeEeg, decodePpg,
  decodeAccel, decodeGyro, decodeTelemetry,
} from '../js/protocol.js';

const view = (bytes) => new DataView(new Uint8Array(bytes).buffer);

// Packs 12-bit values two per three bytes (inverse of the device encoding).
function pack12(values) {
  const out = [];
  for (let i = 0; i < values.length; i += 2) {
    out.push(values[i] >> 4, ((values[i] & 0xf) << 4) | (values[i + 1] >> 8), values[i + 1] & 0xff);
  }
  return out;
}

test('encodeCommand frames text with length prefix and newline', () => {
  assert.deepEqual([...encodeCommand('h')], [2, 0x68, 0x0a]);
  assert.deepEqual([...encodeCommand('p50')], [4, 0x70, 0x35, 0x30, 0x0a]);
});

test('decodeUnsigned12Bit unpacks two samples per three bytes', () => {
  assert.deepEqual(decodeUnsigned12Bit([0xab, 0xcd, 0xef]), [0xabc, 0xdef]);
});

test('decodeUnsigned24Bit reads big endian', () => {
  assert.deepEqual(decodeUnsigned24Bit([0x01, 0x02, 0x03, 0xff, 0xff, 0xff]), [66051, 16777215]);
});

test('decodeEeg returns index and µV samples', () => {
  const raw = [2048, 2049, 0, 4095, 2048 + 100, 2048 - 100, 2048, 2048, 2048, 2048, 2048, 2048];
  const dv = view([0x12, 0x34, ...pack12(raw)]);
  assert.equal(dv.byteLength, 20);
  const { index, samples } = decodeEeg(dv);
  assert.equal(index, 0x1234);
  assert.equal(samples.length, 12);
  assert.equal(samples[0], 0);
  assert.equal(samples[1], 0.48828125);
  assert.equal(samples[2], -1000);
  assert.ok(Math.abs(samples[3] - 0.48828125 * 2047) < 1e-9);
  assert.ok(Math.abs(samples[4] - 48.828125) < 1e-9);
  assert.ok(Math.abs(samples[5] + 48.828125) < 1e-9);
});

test('decodeEeg honours the DataView byte offset', () => {
  const bytes = new Uint8Array(24);
  bytes.set([0x00, 0x07, ...pack12(Array(12).fill(2048 + 10))], 4);
  const { index, samples } = decodeEeg(new DataView(bytes.buffer, 4, 20));
  assert.equal(index, 7);
  assert.ok(samples.every((s) => Math.abs(s - 4.8828125) < 1e-9));
});

test('decodePpg returns six 24-bit samples', () => {
  const dv = view([0x00, 0x05, ...[1, 2, 3, 0, 0, 1, 0, 1, 0, 255, 255, 255, 0, 0, 0, 0, 0, 2]]);
  const { index, samples } = decodePpg(dv);
  assert.equal(index, 5);
  assert.deepEqual(samples, [66051, 1, 256, 16777215, 0, 2]);
});

test('decodeAccel and decodeGyro scale int16 axes', () => {
  const bytes = [0x00, 0x09];
  for (let i = 0; i < 3; i++) bytes.push(0x40, 0x00, 0xff, 0xff, 0x00, 0x00); // x=16384, y=-1, z=0
  const a = decodeAccel(view(bytes));
  assert.equal(a.index, 9);
  assert.equal(a.samples.length, 3);
  assert.ok(Math.abs(a.samples[0][0] - 16384 * 0.0000610352) < 1e-9); // ~1 g
  assert.ok(Math.abs(a.samples[0][1] + 0.0000610352) < 1e-12);
  assert.equal(a.samples[0][2], 0);
  const g = decodeGyro(view(bytes));
  assert.ok(Math.abs(g.samples[2][0] - 16384 * 0.0074768) < 1e-9);
});

test('decodeTelemetry converts battery and voltage', () => {
  const dv = view([0x00, 0x01, 0x64, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x20]);
  const t = decodeTelemetry(dv);
  assert.equal(t.battery, 50);
  assert.ok(Math.abs(t.voltage - 2560 * 2.2) < 1e-9);
  assert.equal(t.temperature, 32);
});

test('short packets are rejected', () => {
  assert.equal(decodeEeg(view([0, 1])), null);
  assert.equal(decodePpg(view([0, 1])), null);
  assert.equal(decodeAccel(view([0, 1, 2])), null);
  assert.equal(decodeTelemetry(view([0, 1])), null);
});
