// UI glue: connects the Muse client to buffers, charts, band power, heart rate and the recorder.

import { MuseClient } from './muse.js';
import { EEG_CHANNELS, PPG_CHANNELS, EEG_RATE, PPG_RATE, MOTION_RATE } from './protocol.js';
import {
  RingBuffer, Biquad, FilterChain, BANDS, bandPowers, estimateHeartRate, signalQuality, HR_MIN_SNR,
} from './dsp.js';
import { Recorder } from './recorder.js';
import { drawLanes } from './chart.js';

const $ = (id) => document.getElementById(id);

// --- Labels (UI text is Portuguese; data ids stay English) ---
const STATE_LABEL = {
  disconnected: 'Desconectado',
  connecting: 'Conectando…',
  connected: 'Conectado',
  reconnecting: 'Reconectando…',
};
const BAND_INFO = {
  delta: { label: 'Delta', color: '#7c8cf8' },
  theta: { label: 'Theta', color: '#4fb3d9' },
  alpha: { label: 'Alfa', color: '#4cc38a' },
  beta: { label: 'Beta', color: '#e3b341' },
  gamma: { label: 'Gama', color: '#f0605d' },
};
const QUALITY_LABEL = { good: 'bom', noisy: 'ruidoso', flat: 'sem sinal' };
const EEG_COLORS = ['#4fb3d9', '#4cc38a', '#e3b341', '#d98cf0'];

// --- Buffers ---
const EEG_SECONDS = 10;
const eegRaw = EEG_CHANNELS.map(() => new RingBuffer(EEG_RATE * EEG_SECONDS));
const eegView = EEG_CHANNELS.map(() => new RingBuffer(EEG_RATE * EEG_SECONDS)); // band-passed, for display
const eegFilters = EEG_CHANNELS.map(() => new FilterChain([Biquad.highpass(EEG_RATE, 1), Biquad.lowpass(EEG_RATE, 40)]));

const ppgRaw = PPG_CHANNELS.map(() => new RingBuffer(PPG_RATE * 10));
const ppgView = PPG_CHANNELS.map(() => new RingBuffer(PPG_RATE * 10));
const ppgFilters = PPG_CHANNELS.map(() => new FilterChain([Biquad.highpass(PPG_RATE, 0.5), Biquad.lowpass(PPG_RATE, 5)]));

const accel = [0, 1, 2].map(() => new RingBuffer(MOTION_RATE * 10));

const BAND_WINDOW = EEG_RATE * 2; // ~2 s
const smoothedPowers = EEG_CHANNELS.map(() => null);
let lastEegAt = 0;
let lastPpgAt = 0;
let currentHr = null;
let hrHistory = [];
let hrMisses = 0;
let autoScale = 100;

// --- State ---
const muse = new MuseClient();
let recorder = null;
let recording = false;
let exported = true;
let wakeLock = null;

// --- Connection ---
function renderState(state) {
  const pill = $('status');
  pill.textContent = state === 'connected' && muse.name ? `${STATE_LABEL[state]} · ${muse.name}` : STATE_LABEL[state];
  pill.className = `pill ${state === 'connected' ? 'ok' : state === 'disconnected' ? '' : 'busy'}`;
  const online = state === 'connected' || state === 'reconnecting';
  $('connect').hidden = online || state === 'connecting';
  $('disconnect').hidden = !online;
  $('record').disabled = state !== 'connected' && !recording;
  if (state === 'disconnected') {
    $('battery').hidden = true;
    if (recording) stopRecording();
    releaseWakeLock();
  }
}

muse.addEventListener('state', (e) => renderState(e.detail));

muse.addEventListener('reconnected', () => {
  recorder?.restart(performance.now());
  for (const f of eegFilters) f.primed = false;
  for (const f of ppgFilters) f.primed = false;
});

muse.addEventListener('telemetry', (e) => {
  const pct = Math.round(e.detail.battery);
  const el = $('battery');
  el.hidden = false;
  el.textContent = `Bateria ${pct}%`;
  el.className = `pill ${pct < 20 ? 'low' : ''}`;
});

muse.addEventListener('eeg', (e) => {
  const { channel, index, samples } = e.detail;
  lastEegAt = performance.now();
  eegRaw[channel].pushMany(samples);
  for (const s of samples) eegView[channel].push(eegFilters[channel].process(s));
  if (recording) recorder.addEeg(channel, index, samples);
});

muse.addEventListener('ppg', (e) => {
  const { channel, index, samples } = e.detail;
  lastPpgAt = performance.now();
  ppgRaw[channel].pushMany(samples);
  for (const s of samples) ppgView[channel].push(ppgFilters[channel].process(s));
  if (recording) recorder.addPpg(channel, index, samples);
});

let lastGyro = null;
muse.addEventListener('accel', (e) => {
  for (const s of e.detail.samples) s.forEach((v, axis) => accel[axis].push(v));
  if (recording) recorder.addMotion('accel', e.detail.index, e.detail.samples);
});
muse.addEventListener('gyro', (e) => {
  lastGyro = e.detail.samples[e.detail.samples.length - 1];
  if (recording) recorder.addMotion('gyro', e.detail.index, e.detail.samples);
});

function showError(message) {
  const el = $('error');
  el.textContent = message ?? '';
  el.hidden = !message;
}

$('connect').addEventListener('click', async () => {
  showError(null);
  try {
    await muse.connect();
    requestWakeLock();
  } catch (err) {
    if (err?.name === 'NotFoundError') return; // chooser dismissed
    showError(`Não foi possível conectar: ${err?.message ?? err}`);
  }
});

$('disconnect').addEventListener('click', () => muse.disconnect());

// --- Charts ---
const eegCanvas = $('eeg-chart');
const ppgCanvas = $('ppg-chart');
const accelCanvas = $('accel-chart');

function lastSamples(ring, seconds, rate) {
  return ring.toArray(Math.round(seconds * rate));
}

function removeMean(arr) {
  if (arr.length === 0) return arr;
  let m = 0;
  for (const v of arr) m += v;
  m /= arr.length;
  return arr.map((v) => v - m);
}

function maxAbs(arr) {
  let m = 0;
  for (const v of arr) m = Math.max(m, Math.abs(v));
  return m;
}

function frame() {
  const seconds = Number($('eeg-window').value);
  const filtered = $('eeg-filter').checked;
  const scaleSetting = $('eeg-scale').value;

  const series = EEG_CHANNELS.map((_, ch) => {
    const data = lastSamples(filtered ? eegView[ch] : eegRaw[ch], seconds, EEG_RATE);
    return filtered ? data : removeMean(data);
  });
  if (scaleSetting === 'auto') {
    const peak = Math.max(...series.map(maxAbs));
    autoScale += (Math.max(20, peak * 1.15) - autoScale) * 0.1;
  }
  const scale = scaleSetting === 'auto' ? autoScale : Number(scaleSetting);
  drawLanes(
    eegCanvas,
    EEG_CHANNELS.map((name, ch) => ({ label: name, data: series[ch], scale, color: EEG_COLORS[ch], unit: 'µV' })),
    seconds * EEG_RATE,
  );

  const ppg = removeMean(lastSamples(ppgView[1], 8, PPG_RATE));
  drawLanes(
    ppgCanvas,
    [{ label: 'infravermelho', data: ppg, scale: Math.max(50, maxAbs(ppg) * 1.1), color: '#f0605d', unit: 'u.a.' }],
    8 * PPG_RATE,
  );

  drawLanes(
    accelCanvas,
    ['x', 'y', 'z'].map((axis, i) => ({
      label: `acel ${axis}`,
      data: lastSamples(accel[i], 5, MOTION_RATE),
      scale: 2,
      color: EEG_COLORS[i],
      unit: 'g',
    })),
    5 * MOTION_RATE,
  );

  requestAnimationFrame(frame);
}

// --- Band power + signal quality (twice per second) ---
function buildBandsUi() {
  const wrap = $('bands');
  for (const b of BANDS) {
    const info = BAND_INFO[b.id];
    const row = document.createElement('div');
    row.className = 'band';
    row.innerHTML = `<div class="name">${info.label}<small>${b.lo}–${b.hi} Hz</small></div>
      <div class="track"><div class="fill" id="fill-${b.id}" style="background:${info.color}"></div></div>
      <div class="pct" id="pct-${b.id}">--</div>`;
    wrap.appendChild(row);
  }
  $('band-table').querySelector('thead tr').innerHTML =
    `<th>dB (µV²)</th>${BANDS.map((b) => `<th>${BAND_INFO[b.id].label}</th>`).join('')}`;
  $('band-table').querySelector('tbody').innerHTML = EEG_CHANNELS.map(
    (name, ch) => `<tr><td>${name}</td>${BANDS.map((b) => `<td id="db-${ch}-${b.id}">--</td>`).join('')}</tr>`,
  ).join('');
  $('quality').innerHTML = EEG_CHANNELS.map((name, ch) => `<span class="chip" id="q-${ch}">${name}</span>`).join('');
}

function updateBands() {
  if (performance.now() - lastEegAt > 2000) return; // no live data
  const updated = [];
  EEG_CHANNELS.forEach((_, ch) => {
    if (eegRaw[ch].count < BAND_WINDOW) return;
    const p = bandPowers(eegRaw[ch].toArray(BAND_WINDOW), EEG_RATE);
    const prev = smoothedPowers[ch];
    smoothedPowers[ch] = prev ? p.map((v, i) => prev[i] * 0.6 + v * 0.4) : p;
    updated.push(ch);

    const q = signalQuality(eegView[ch].toArray(EEG_RATE));
    const chip = $(`q-${ch}`);
    chip.className = `chip ${q.state}`;
    chip.textContent = `${EEG_CHANNELS[ch]} ${QUALITY_LABEL[q.state]}`;
  });
  if (updated.length === 0) return;

  // Relative power averaged over the channels that have data.
  const rel = BANDS.map(() => 0);
  for (const ch of updated) {
    const total = smoothedPowers[ch].reduce((a, b) => a + b, 0) || 1;
    smoothedPowers[ch].forEach((v, i) => { rel[i] += v / total / updated.length; });
  }
  BANDS.forEach((b, i) => {
    $(`fill-${b.id}`).style.width = `${(rel[i] * 100).toFixed(1)}%`;
    $(`pct-${b.id}`).textContent = `${(rel[i] * 100).toFixed(0)}%`;
  });
  updated.forEach((ch) => {
    BANDS.forEach((b, i) => {
      $(`db-${ch}-${b.id}`).textContent = (10 * Math.log10(smoothedPowers[ch][i] + 1e-12)).toFixed(1);
    });
  });

  if (recording && updated.length === EEG_CHANNELS.length) {
    recorder.addBands(performance.now(), smoothedPowers, currentHr);
  }
}

// --- Heart rate (once per second) ---
function updateHeartRate() {
  const hint = $('hr-hint');
  if (performance.now() - lastPpgAt > 3000) {
    $('hr').textContent = '--';
    hint.textContent = lastPpgAt ? 'Sem dados de PPG.' : 'Aguardando dados do PPG…';
    currentHr = null;
    return;
  }
  const ready = ppgRaw[1].count >= PPG_RATE * 6;
  if (!ready) {
    hint.textContent = 'Medindo… (precisa de ~6 s de sinal)';
    return;
  }
  const n = Math.min(ppgRaw[1].count, PPG_RATE * 10);
  const candidates = [1, 2]
    .map((ch) => estimateHeartRate(ppgRaw[ch].toArray(n), PPG_RATE))
    .filter(Boolean);
  const best = candidates.sort((a, b) => b.snr - a.snr)[0];

  if (best && best.snr >= HR_MIN_SNR) {
    hrMisses = 0;
    hrHistory.push(best.bpm);
    if (hrHistory.length > 5) hrHistory.shift();
    const sorted = [...hrHistory].sort((a, b) => a - b);
    currentHr = sorted[Math.floor(sorted.length / 2)];
    $('hr').textContent = Math.round(currentHr);
    hint.textContent = 'Estimativa pelo espectro do PPG (janela de 10 s). Fique parado.';
  } else if (++hrMisses >= 3) {
    hrHistory = [];
    currentHr = null;
    $('hr').textContent = '--';
    hint.textContent = 'Sinal fraco. Ajuste o headband na testa e fique parado.';
  }
}

// --- Recording / export ---
function formatDuration(seconds) {
  const s = Math.floor(seconds);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function setExportEnabled(enabled) {
  document.querySelectorAll('[data-export]').forEach((b) => { b.disabled = !enabled; });
}

function startRecording() {
  if (recorder && !recorder.isEmpty && !exported && !confirm('Descartar a gravação anterior, ainda não exportada?')) return;
  recorder = new Recorder(performance.now());
  exported = false;
  recording = true;
  setExportEnabled(false);
  $('record').textContent = 'Parar gravação';
  $('record').classList.add('recording');
  requestWakeLock();
}

function stopRecording() {
  recording = false;
  $('record').textContent = 'Gravar';
  $('record').classList.remove('recording');
  $('record').disabled = muse.state !== 'connected';
  setExportEnabled(recorder && !recorder.isEmpty);
  updateRecordingInfo();
}

function updateRecordingInfo() {
  const info = $('rec-info');
  if (recording) {
    const eeg = recorder.streams.eeg.length;
    info.textContent = `● ${formatDuration(recorder.durationSeconds(performance.now()))} · ${eeg} amostras EEG`;
  } else if (recorder && !recorder.isEmpty) {
    info.textContent = `Gravação pronta · ${recorder.streams.eeg.length} amostras EEG`;
  } else {
    info.textContent = 'Parado';
  }
}

$('record').addEventListener('click', () => (recording ? stopRecording() : startRecording()));

const EXPORT_NAME = { eeg: 'eeg', ppg: 'ppg', motion: 'movimento', bands: 'bandas' };

document.querySelectorAll('[data-export]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const kind = btn.dataset.export;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const blob = new Blob(recorder.csvParts(kind), { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `muse2-${stamp}-${EXPORT_NAME[kind]}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    exported = true;
  });
});

// --- Screen wake lock (the phone must not sleep while streaming) ---
async function requestWakeLock() {
  try {
    if (!wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not allowed (e.g. low battery); ignore */ }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && muse.state !== 'disconnected') requestWakeLock();
});

// --- Boot ---
function showGyro() {
  if (lastGyro) {
    $('gyro').textContent = `Giroscópio (°/s): x ${lastGyro[0].toFixed(1)} · y ${lastGyro[1].toFixed(1)} · z ${lastGyro[2].toFixed(1)}`;
  }
}

buildBandsUi();
renderState('disconnected');
if (!MuseClient.isSupported) {
  $('unsupported').hidden = false;
  $('connect').disabled = true;
}
setInterval(updateBands, 500);
setInterval(updateHeartRate, 1000);
setInterval(() => { updateRecordingInfo(); showGyro(); }, 500);
requestAnimationFrame(frame);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
