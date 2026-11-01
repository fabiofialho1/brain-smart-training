// Session recorder: keeps every sample and exports CSV.
// Samples are placed by BLE packet index (not arrival time), so lost packets
// show up as empty cells instead of silently shifting the time axis.
// Covered by tests/muse-recorder.test.mjs.

import {
  EEG_CHANNELS, PPG_CHANNELS, EEG_RATE, PPG_RATE, MOTION_RATE,
  EEG_PER_PACKET, PPG_PER_PACKET, MOTION_PER_PACKET,
} from './protocol.js';
import { BANDS } from './dsp.js';

const signed16 = (x) => (((x + 0x8000) & 0xffff) - 0x8000);

// Growable Float32Array. Gaps are filled with NaN.
class GrowArray {
  constructor() {
    this.data = new Float32Array(4096);
    this.length = 0;
  }

  setRange(pos, values) {
    const end = pos + values.length;
    if (end > this.data.length) {
      const bigger = new Float32Array(Math.max(end, this.data.length * 2));
      bigger.set(this.data.subarray(0, this.length));
      this.data = bigger;
    }
    if (pos > this.length) this.data.fill(NaN, this.length, pos);
    this.data.set(values, pos);
    if (end > this.length) this.length = end;
  }
}

class Stream {
  constructor({ rate, perPacket, columns }) {
    this.rate = rate;
    this.perPacket = perPacket;
    this.columns = columns;
    this.series = columns.map(() => new GrowArray());
    this.offset = 0; // samples; moved forward after a reconnection
    this.base = null; // first packet index seen in the current segment
    this.prev = columns.map(() => null);
  }

  // After a reconnection the device restarts its packet counter.
  restart(offsetSamples) {
    this.offset = Math.max(this.offset, offsetSamples);
    this.base = null;
    this.prev.fill(null);
  }

  add(col, index, values) {
    if (this.base === null) this.base = index;
    const prev = this.prev[col];
    let rel;
    if (prev === null) {
      rel = signed16(index - this.base);
    } else {
      const d = signed16(index - prev.index);
      if (d <= 0) return; // duplicate or out of order
      rel = prev.rel + d;
    }
    this.prev[col] = { index, rel };
    const pos = this.offset + rel * this.perPacket;
    if (pos >= 0) this.series[col].setRange(pos, values);
  }

  get length() {
    return Math.max(0, ...this.series.map((s) => s.length));
  }

  *csvChunks(rowsPerChunk = 5000) {
    yield `time_s,${this.columns.join(',')}\n`;
    const n = this.length;
    for (let start = 0; start < n; start += rowsPerChunk) {
      const rows = [];
      for (let i = start; i < Math.min(n, start + rowsPerChunk); i++) {
        const cells = [(i / this.rate).toFixed(4)];
        for (const s of this.series) {
          cells.push(i < s.length && !Number.isNaN(s.data[i]) ? +s.data[i].toFixed(4) : '');
        }
        rows.push(cells.join(','));
      }
      yield `${rows.join('\n')}\n`;
    }
  }
}

export class Recorder {
  constructor(startMs) {
    this.startMs = startMs;
    this.streams = {
      eeg: new Stream({ rate: EEG_RATE, perPacket: EEG_PER_PACKET, columns: EEG_CHANNELS }),
      ppg: new Stream({ rate: PPG_RATE, perPacket: PPG_PER_PACKET, columns: PPG_CHANNELS }),
      motion: new Stream({
        rate: MOTION_RATE,
        perPacket: MOTION_PER_PACKET,
        columns: ['acc_x_g', 'acc_y_g', 'acc_z_g', 'gyro_x_dps', 'gyro_y_dps', 'gyro_z_dps'],
      }),
    };
    this.bandRows = [];
  }

  restart(nowMs) {
    const seconds = (nowMs - this.startMs) / 1000;
    for (const s of Object.values(this.streams)) s.restart(Math.round(seconds * s.rate));
  }

  addEeg(channel, index, samples) {
    this.streams.eeg.add(channel, index, samples);
  }

  addPpg(channel, index, samples) {
    this.streams.ppg.add(channel, index, samples);
  }

  // `samples`: [[x, y, z], ...]; `kind`: 'accel' or 'gyro'.
  addMotion(kind, index, samples) {
    const base = kind === 'accel' ? 0 : 3;
    for (let axis = 0; axis < 3; axis++) {
      this.streams.motion.add(base + axis, index, samples.map((s) => s[axis]));
    }
  }

  // `powers[channel][band]` in µV²; `hr` in bpm or null.
  addBands(nowMs, powers, hr) {
    this.bandRows.push({ t: (nowMs - this.startMs) / 1000, powers, hr });
  }

  get isEmpty() {
    return this.streams.eeg.length === 0 && this.streams.ppg.length === 0 && this.streams.motion.length === 0;
  }

  durationSeconds(nowMs) {
    return (nowMs - this.startMs) / 1000;
  }

  *bandsCsvChunks() {
    const cols = [];
    for (const ch of EEG_CHANNELS) for (const b of BANDS) cols.push(`${ch}_${b.id}_uv2`);
    yield `time_s,${cols.join(',')},hr_bpm\n`;
    yield this.bandRows
      .map((r) => [r.t.toFixed(3), ...r.powers.flat().map((p) => +p.toFixed(4)), r.hr == null ? '' : r.hr.toFixed(1)].join(','))
      .join('\n') + (this.bandRows.length ? '\n' : '');
  }

  // Returns the CSV pieces for 'eeg', 'ppg', 'motion' or 'bands'.
  csvParts(kind) {
    return [...(kind === 'bands' ? this.bandsCsvChunks() : this.streams[kind].csvChunks())];
  }
}
