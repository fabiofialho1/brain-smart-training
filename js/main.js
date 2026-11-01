// UI glue: connects the Muse client to buffers, charts, band power, heart rate and the recorder.

import { MuseClient } from './muse.js';
import { EEG_CHANNELS, PPG_CHANNELS, EEG_RATE, PPG_RATE, MOTION_RATE } from './protocol.js';
import {
  RingBuffer, Biquad, FilterChain, BANDS, analyzeWindow, bandDensityDb, BandAccumulator, QualityTracker, estimateHeartRate, heartSignalState, HR_MIN_SECONDS,
} from './dsp.js';
import { Recorder } from './recorder.js';
import { drawLanes, drawBandChart } from './chart.js';

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
// Analysis signal (bands, quality): raw minus slow drift. Electrode drift is hundreds of µV below
// 1 Hz and would otherwise leak into delta and inflate the rms; no low-pass here, the quality
// check needs to see 55-100 Hz.
const eegAnalysis = EEG_CHANNELS.map(() => new RingBuffer(EEG_RATE * EEG_SECONDS));
const analysisFilters = EEG_CHANNELS.map(() => new FilterChain([
  Biquad.highpass(EEG_RATE, 0.5, 0.5412),
  Biquad.highpass(EEG_RATE, 0.5, 1.3066),
]));
const lastEegIndex = EEG_CHANNELS.map(() => null);
const lostEegPackets = EEG_CHANNELS.map(() => 0);
// Display filter: 1 Hz high-pass, 4th-order 40 Hz low-pass (two Butterworth sections) and a
// 50 Hz notch for mains pickup. The analysis (bands, quality) works on the raw signal.
const eegFilters = EEG_CHANNELS.map(() => new FilterChain([
  Biquad.highpass(EEG_RATE, 1),
  Biquad.lowpass(EEG_RATE, 40, 0.5412),
  Biquad.lowpass(EEG_RATE, 40, 1.3066),
  Biquad.notch(EEG_RATE, 50),
]));

const ppgRaw = PPG_CHANNELS.map(() => new RingBuffer(PPG_RATE * 10));
const ppgView = PPG_CHANNELS.map(() => new RingBuffer(PPG_RATE * 10));
const ppgFilters = PPG_CHANNELS.map(() => new FilterChain([Biquad.highpass(PPG_RATE, 0.5), Biquad.lowpass(PPG_RATE, 5)]));

const accel = [0, 1, 2].map(() => new RingBuffer(MOTION_RATE * 10));

const BAND_WINDOW = EEG_RATE * 2; // ~2 s
const smoothedPowers = EEG_CHANNELS.map(() => null);
const channelState = EEG_CHANNELS.map(() => 'flat');
const qualityTracker = new QualityTracker(EEG_CHANNELS.length);
const bandHistory = []; // { t, db: number[] | null }, one point per second; null marks a gap
const visibleBands = new Set(BANDS.map((_, i) => i));
const HISTORY_MAX_MS = 10 * 60 * 1000;
const CHART_INTERVAL_MS = 4000; // one chart point per 4 s, like the Muse app
const chartAcc = new BandAccumulator(EEG_CHANNELS.length);
let lastChartPoint = 0;
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
  $('use-ppg').disabled = state !== 'disconnected';
  if (state === 'disconnected') {
    $('battery').hidden = true;
    if (recording) stopRecording();
    releaseWakeLock();
  }
}

let connectedAt = 0;
muse.addEventListener('state', (e) => {
  if (e.detail === 'connected') connectedAt = performance.now();
  if (e.detail === 'connecting') {
    for (const r of [...ppgRaw, ...ppgView]) r.clear();
    hrHistory = [];
    hrMisses = 0;
    lastPpgAt = 0;
  }
  renderState(e.detail);
});

muse.addEventListener('reconnected', () => {
  recorder?.restart(performance.now());
  for (const f of eegFilters) f.primed = false;
  for (const f of analysisFilters) f.primed = false;
  lastEegIndex.fill(null);
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
  for (const s of samples) eegAnalysis[channel].push(analysisFilters[channel].process(s));
  const prevIndex = lastEegIndex[channel];
  if (prevIndex !== null) {
    const step = (index - prevIndex) & 0xffff;
    if (step > 1 && step < 1000) lostEegPackets[channel] += step - 1;
  }
  lastEegIndex[channel] = index;
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

// PPG on/off: applies on the next connection; remembered between visits.
try { $('use-ppg').checked = localStorage.getItem('use-ppg') !== '0'; } catch { /* storage blocked */ }
muse.usePpg = $('use-ppg').checked;
$('use-ppg').addEventListener('change', () => {
  muse.usePpg = $('use-ppg').checked;
  try { localStorage.setItem('use-ppg', muse.usePpg ? '1' : '0'); } catch { /* ignore */ }
});

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

  drawBandChart($('band-chart'), {
    history: bandHistory,
    bands: BANDS.map((b) => BAND_INFO[b.id]),
    visible: visibleBands,
    now: performance.now(),
    windowMs: Number($('band-window').value) * 1000,
  });

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
    `<th>dB (µV²/Hz)</th>${BANDS.map((b) => `<th>${BAND_INFO[b.id].label}</th>`).join('')}`;
  $('band-table').querySelector('tbody').innerHTML = EEG_CHANNELS.map(
    (name, ch) => `<tr id="row-${ch}"><td>${name}</td>${BANDS.map((b) => `<td id="db-${ch}-${b.id}">--</td>`).join('')}</tr>`,
  ).join('');
  const filter = $('band-filter');
  const chips = [{ label: 'Todas', set: () => BANDS.map((_, i) => i) }, ...BANDS.map((b, i) => ({
    label: BAND_INFO[b.id].label, set: () => [i], color: BAND_INFO[b.id].color,
  }))];
  chips.forEach((c, n) => {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.textContent = c.label;
    if (c.color) btn.style.borderColor = c.color;
    btn.setAttribute('aria-pressed', String(n === 0));
    btn.addEventListener('click', () => {
      visibleBands.clear();
      c.set().forEach((i) => visibleBands.add(i));
      [...filter.children].forEach((el, m) => el.setAttribute('aria-pressed', String(m === n)));
    });
    filter.appendChild(btn);
  });
  $('diag-body').innerHTML = EEG_CHANNELS.map((name, ch) => `<tr id="diag-${ch}"><td>${name}</td><td>--</td><td>--</td><td>--</td><td>--</td><td>--</td></tr>`).join('');
  $('quality').innerHTML = EEG_CHANNELS.map((name, ch) => `<span class="chip" id="q-${ch}">${name}</span>`).join('')
    + '<span class="chip" id="q-hr">Coração aguardando</span>';
}

function updateBands() {
  if (performance.now() - lastEegAt > 2000) return; // no live data
  const updated = [];
  EEG_CHANNELS.forEach((_, ch) => {
    if (eegAnalysis[ch].count < BAND_WINDOW) return;
    const { powers, quality } = analyzeWindow(eegAnalysis[ch].toArray(BAND_WINDOW), EEG_RATE);
    const prev = smoothedPowers[ch];
    smoothedPowers[ch] = prev ? powers.map((v, i) => prev[i] * 0.6 + v * 0.4) : powers;
    // The chart looks at every window (an artifact edge must not leak in); the indicator and the
    // bars use the debounced state so they do not flicker around a threshold.
    chartAcc.add(ch, powers, quality.state);
    const stable = qualityTracker.update(ch, quality.state);
    channelState[ch] = stable;
    $(`diag-${ch}`).innerHTML = `<td>${EEG_CHANNELS[ch]}</td><td>${quality.rms.toFixed(0)}</td><td>${quality.hfDb.toFixed(1)}</td><td>${quality.mainsDb.toFixed(1)}</td><td>${QUALITY_LABEL[quality.state]} / ${QUALITY_LABEL[stable]}</td><td>${lostEegPackets[ch]}</td>`;
    updated.push(ch);

    const chip = $(`q-${ch}`);
    chip.className = `chip ${stable}`;
    chip.textContent = `${EEG_CHANNELS[ch]} ${QUALITY_LABEL[stable]}`;
  });
  if (updated.length === 0) return;
  $('settle-note').hidden = !(performance.now() - connectedAt < 90000 && channelState.some((st) => st === 'noisy'));

  // Summary bars only use channels with good contact; a single noisy electrode would otherwise
  // dominate the linear average. If none is good, fall back to all so the screen is not empty.
  const good = updated.filter((ch) => channelState[ch] === 'good');
  const used = good.length > 0 ? good : updated;
  $('bands-note').textContent = good.length > 0
    ? `Barras calculadas com: ${good.map((ch) => EEG_CHANNELS[ch]).join(', ')}${good.length < updated.length ? ' (canais ruins excluídos)' : ''}.`
    : 'Nenhum canal com bom contato; ajuste o headband. Barras usando todos os canais.';

  const rel = BANDS.map(() => 0);
  for (const ch of used) {
    const total = smoothedPowers[ch].reduce((a, b) => a + b, 0) || 1;
    smoothedPowers[ch].forEach((v, i) => { rel[i] += v / total / used.length; });
  }
  BANDS.forEach((b, i) => {
    $(`fill-${b.id}`).style.width = `${(rel[i] * 100).toFixed(1)}%`;
    $(`pct-${b.id}`).textContent = `${(rel[i] * 100).toFixed(0)}%`;
  });
  updated.forEach((ch) => {
    $(`row-${ch}`).classList.toggle('excluded', !used.includes(ch));
    BANDS.forEach((b, i) => {
      $(`db-${ch}-${b.id}`).textContent = bandDensityDb(smoothedPowers[ch][i], b).toFixed(1);
    });
  });

  const now = performance.now();
  if (lastChartPoint === 0) lastChartPoint = now;
  if (now - lastChartPoint >= CHART_INTERVAL_MS) {
    const db = chartAcc.flush();
    const last = bandHistory[bandHistory.length - 1];
    if (db) {
      if (last?.db && now - last.t > 1.5 * CHART_INTERVAL_MS) bandHistory.push({ t: last.t + 1, db: null });
      bandHistory.push({ t: now, db });
      while (bandHistory[0].t < now - HISTORY_MAX_MS) bandHistory.shift();
    }
    lastChartPoint = now;
  }

  if (recording && updated.length === EEG_CHANNELS.length) {
    recorder.addBands(performance.now(), smoothedPowers, currentHr);
  }
}

// --- Heart rate (once per second) ---
const HEART_CHIP = {
  off: ['Coração desligado', ''],
  waiting: ['Coração aguardando', ''],
  measuring: ['Coração medindo…', ''],
  good: ['Coração bom', 'good'],
  weak: ['Coração sinal fraco', 'noisy'],
};
let heartState = 'waiting';

function setHeartChip(state) {
  const [label, cls] = HEART_CHIP[state];
  const chip = $('q-hr');
  chip.className = `chip ${cls}`;
  chip.textContent = label;
}

function updateHeartRate() {
  const hint = $('hr-hint');
  const ppgOn = !(muse.state === 'connected' && !muse.hasPpg);
  const msSince = lastPpgAt ? performance.now() - lastPpgAt : null;
  const n = Math.min(ppgRaw[1].count, PPG_RATE * 10);
  let best = null;
  if (ppgOn && msSince !== null && msSince <= 3000 && n >= PPG_RATE * HR_MIN_SECONDS) {
    best = estimateHeartRate(ppgRaw[1].toArray(n), PPG_RATE);
  }
  let state = heartSignalState({ ppgOn, msSinceData: msSince, samples: n, fs: PPG_RATE, snr: best ? best.snr : null });
  // A weak reading only counts after 3 in a row, so the indicator does not flicker.
  if (state === 'weak') {
    hrMisses++;
    if (hrMisses < 3) state = heartState === 'good' ? 'good' : 'measuring';
  } else if (state === 'good') {
    hrMisses = 0;
  }
  heartState = state;
  setHeartChip(state);

  if (state === 'off') {
    $('hr').textContent = '--';
    hint.textContent = 'PPG desligado. Marque "Medir frequência cardíaca" e reconecte para medir.';
    currentHr = null;
  } else if (state === 'waiting') {
    $('hr').textContent = '--';
    hint.textContent = lastPpgAt ? 'Sem dados de PPG.' : 'Aguardando dados do PPG…';
    currentHr = null;
  } else if (state === 'measuring') {
    hint.textContent = 'Medindo… (precisa de ~6 s de sinal)';
  } else if (state === 'good') {
    hrHistory.push(best.bpm);
    if (hrHistory.length > 5) hrHistory.shift();
    const sorted = [...hrHistory].sort((a, b) => a - b);
    currentHr = sorted[Math.floor(sorted.length / 2)];
    $('hr').textContent = Math.round(currentHr);
    hint.textContent = 'Estimativa pelo espectro do PPG (janela de 10 s). Fique parado.';
  } else {
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
