// Web Bluetooth client for the Muse 2. Emits:
//   'state'     detail = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
//   'eeg'       detail = { channel, index, samples }     (µV, 12 per packet)
//   'ppg'       detail = { channel, index, samples }     (raw counts, 6 per packet)
//   'accel'     detail = { index, samples }              (g, 3 x [x, y, z])
//   'telemetry' detail = { battery, voltage, temperature }
//   'reconnected'  after an automatic reconnection (packet counters restart)

import {
  MUSE_SERVICE, CHAR, COMMANDS, encodeCommand,
  decodeEeg, decodePpg, decodeAccel, decodeTelemetry,
} from './protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Android's BLE stack rejects overlapping GATT operations; retry a few times.
async function withRetry(fn, tries = 3) {
  let lastError;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      await sleep(250 * (i + 1));
    }
  }
  throw lastError;
}

export class MuseClient extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.control = null;
    this.state = 'disconnected';
    this.manualDisconnect = false;
    this.hasPpg = false;
    this.usePpg = true; // false: preset p21 (EEG only), PPG LEDs stay off
    this._openId = 0;
    this._eegSeen = false;
    this._onGattDisconnected = () => this._handleDisconnect();
  }

  static get isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  get name() {
    return this.device?.name ?? '';
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _setState(state) {
    this.state = state;
    this._emit('state', state);
  }

  // Must be called from a user gesture (button click).
  async connect() {
    this.manualDisconnect = false;
    this._setState('connecting');
    try {
      if (!this.device) {
        this.device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: 'Muse' }],
          optionalServices: [MUSE_SERVICE],
        });
        this.device.addEventListener('gattserverdisconnected', this._onGattDisconnected);
      }
      await this._open();
    } catch (e) {
      this._cleanup();
      this._setState('disconnected');
      throw e;
    }
  }

  async disconnect() {
    this.manualDisconnect = true;
    try {
      if (this.control && this.server?.connected) await this._send(COMMANDS.halt);
    } catch { /* already gone */ }
    this._cleanup();
    this._setState('disconnected');
  }

  _cleanup() {
    try {
      if (this.server?.connected) this.server.disconnect();
    } catch { /* ignore */ }
    this.server = null;
    this.control = null;
  }

  async _open() {
    this.server = await withRetry(() => this.device.gatt.connect());
    const service = await withRetry(() => this.server.getPrimaryService(MUSE_SERVICE));
    const openId = ++this._openId;
    this._eegSeen = false;

    this.control = await service.getCharacteristic(CHAR.control);
    await withRetry(() => this.control.startNotifications()); // command replies; ignored

    // PPG exists only on the Muse 2 / Muse S; the preset depends on it.
    this.hasPpg = false;
    if (this.usePpg) {
      try {
        await service.getCharacteristic(CHAR.ppg[1]);
        this.hasPpg = true;
      } catch { /* no PPG on this headband */ }
    }

    // Same order as the official app: query, halt, preset, status, subscribe, start.
    for (const cmd of [COMMANDS.version, COMMANDS.status, COMMANDS.halt,
      this.hasPpg ? COMMANDS.presetEegPpg : COMMANDS.presetEeg, COMMANDS.status]) {
      await this._send(cmd);
      await sleep(80);
    }

    for (let ch = 0; ch < CHAR.eeg.length; ch++) {
      await this._subscribe(service, CHAR.eeg[ch], (dv) => {
        const p = decodeEeg(dv);
        if (!p) return;
        this._eegSeen = true;
        this._emit('eeg', { channel: ch, ...p });
      });
    }
    await this._subscribe(service, CHAR.accel, (dv) => {
      const p = decodeAccel(dv);
      if (p) this._emit('accel', p);
    });
    await this._subscribe(service, CHAR.telemetry, (dv) => {
      const t = decodeTelemetry(dv);
      if (t) this._emit('telemetry', t);
    });
    // Only the infrared PPG channel (the official app skips ambient and red) and the unknown
    // slow stream it also subscribes to. The gyroscope is not subscribed, like the official app.
    if (this.hasPpg) {
      await this._subscribe(service, CHAR.ppg[1], (dv) => {
        const p = decodePpg(dv);
        if (p) this._emit('ppg', { channel: 1, ...p });
      });
    }
    try {
      await this._subscribe(service, CHAR.slow, () => {});
    } catch { /* optional */ }

    await this._send(COMMANDS.start);
    this._setState('connected');

    // If this firmware ignores `dc001`, fall back to the older `d` start command.
    setTimeout(async () => {
      if (this._openId !== openId || this._eegSeen || !this.control || !this.server?.connected) return;
      try {
        await this._send(COMMANDS.resume);
      } catch { /* link dropped meanwhile */ }
    }, 3000);
  }

  async _subscribe(service, uuid, handler) {
    const char = await service.getCharacteristic(uuid);
    char.addEventListener('characteristicvaluechanged', (ev) => handler(ev.target.value));
    await withRetry(() => char.startNotifications());
  }

  async _send(cmd) {
    const bytes = encodeCommand(cmd);
    const props = this.control.properties;
    if (props?.writeWithoutResponse && this.control.writeValueWithoutResponse) {
      await this.control.writeValueWithoutResponse(bytes);
    } else if (this.control.writeValueWithResponse) {
      await this.control.writeValueWithResponse(bytes);
    } else {
      await this.control.writeValue(bytes);
    }
  }

  _handleDisconnect() {
    if (this.manualDisconnect || this.state === 'reconnecting') return;
    this.server = null;
    this.control = null;
    this._reconnect();
  }

  async _reconnect() {
    this._setState('reconnecting');
    for (let attempt = 1; attempt <= 5 && !this.manualDisconnect; attempt++) {
      await sleep(1000 * attempt);
      if (this.manualDisconnect) return;
      try {
        await this._open();
        this._emit('reconnected');
        return;
      } catch {
        this._cleanup();
      }
    }
    if (!this.manualDisconnect) this._setState('disconnected');
  }
}
