// Muse 2 BLE protocol (GATT service 0xfe8d). Pure functions, no Web Bluetooth
// calls, so everything here is unit-tested (tests/muse-protocol.test.mjs).
// Based on the open-source muse-js implementation.

export const MUSE_SERVICE = 0xfe8d;

const uuid = (id) => `273e${id}-4c4d-454d-96be-f03bac821358`;

export const CHAR = {
  control: uuid('0001'),
  gyro: uuid('0009'),
  accel: uuid('000a'),
  telemetry: uuid('000b'),
  eeg: [uuid('0003'), uuid('0004'), uuid('0005'), uuid('0006')], // TP9, AF7, AF8, TP10
  ppg: [uuid('000f'), uuid('0010'), uuid('0011')], // ambient, infrared, red
};

export const EEG_CHANNELS = ['TP9', 'AF7', 'AF8', 'TP10'];
export const PPG_CHANNELS = ['ambient', 'infrared', 'red'];

export const EEG_RATE = 256;
export const PPG_RATE = 64;
export const MOTION_RATE = 52;

export const EEG_PER_PACKET = 12;
export const PPG_PER_PACKET = 6;
export const MOTION_PER_PACKET = 3;

const EEG_SCALE_UV = 0.48828125; // µV per LSB (12 bit, offset 0x800)
const ACCEL_SCALE_G = 0.0000610352; // g per LSB
const GYRO_SCALE_DPS = 0.0074768; // °/s per LSB

// Control commands. `p21` = 4 EEG channels, `p50` = 4 EEG channels + PPG.
export const COMMANDS = {
  halt: 'h',
  resume: 'd',
  status: 's',
  presetEeg: 'p21',
  presetEegPpg: 'p50',
};

// Commands are sent as [length, ...ascii, '\n'] where length counts the text plus '\n'.
export function encodeCommand(cmd) {
  const out = new Uint8Array(cmd.length + 2);
  out[0] = cmd.length + 1;
  for (let i = 0; i < cmd.length; i++) out[i + 1] = cmd.charCodeAt(i);
  out[out.length - 1] = 0x0a;
  return out;
}

// Two 12-bit samples are packed in every 3 bytes (big endian).
export function decodeUnsigned12Bit(bytes) {
  const out = [];
  for (let i = 0; i + 2 < bytes.length; i += 3) {
    out.push((bytes[i] << 4) | (bytes[i + 1] >> 4));
    out.push(((bytes[i + 1] & 0x0f) << 8) | bytes[i + 2]);
  }
  return out;
}

export function decodeUnsigned24Bit(bytes) {
  const out = [];
  for (let i = 0; i + 2 < bytes.length; i += 3) {
    out.push((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]);
  }
  return out;
}

const payload = (dv) => new Uint8Array(dv.buffer, dv.byteOffset + 2, dv.byteLength - 2);

// EEG packet: uint16 packet index + 12 samples of 12 bit. Returns µV.
export function decodeEeg(dv) {
  if (dv.byteLength < 5) return null;
  const samples = decodeUnsigned12Bit(payload(dv)).map((v) => EEG_SCALE_UV * (v - 0x800));
  return { index: dv.getUint16(0), samples };
}

// PPG packet: uint16 index + 6 samples of unsigned 24 bit (raw sensor counts).
export function decodePpg(dv) {
  if (dv.byteLength < 5) return null;
  return { index: dv.getUint16(0), samples: decodeUnsigned24Bit(payload(dv)) };
}

// Accelerometer / gyroscope packet: uint16 index + 3 samples of (x, y, z) int16.
function decodeMotion(dv, scale) {
  if (dv.byteLength < 8) return null;
  const samples = [];
  for (let off = 2; off + 6 <= dv.byteLength && samples.length < MOTION_PER_PACKET; off += 6) {
    samples.push([dv.getInt16(off) * scale, dv.getInt16(off + 2) * scale, dv.getInt16(off + 4) * scale]);
  }
  return { index: dv.getUint16(0), samples };
}

export const decodeAccel = (dv) => decodeMotion(dv, ACCEL_SCALE_G); // g
export const decodeGyro = (dv) => decodeMotion(dv, GYRO_SCALE_DPS); // °/s

// Telemetry packet: index, battery (1/512 %), fuel gauge voltage (2.2 mV/LSB), ?, temperature.
export function decodeTelemetry(dv) {
  if (dv.byteLength < 6) return null;
  return {
    battery: dv.getUint16(2) / 512, // percent
    voltage: dv.getUint16(4) * 2.2, // mV
    temperature: dv.byteLength >= 10 ? dv.getUint16(8) : null,
  };
}
