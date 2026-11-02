// Rocket game: check the sensors, calibrate on the child's own baseline, then play.
// The rocket climbs while the child stays calm. Nothing leaves the phone.

import {
  suggestChannels, channelFeatures, Baseline, computeScore, RewardController, Rocket, EEG_POSTERIOR,
} from './neuro.js';
import { Scene } from './scene.js';

const NAMES = ['TP9', 'AF7', 'AF8', 'TP10'];
const STATE_LABEL = { good: 'bom', noisy: 'ruidoso', flat: 'sem sinal' };

// ?calib=10&play=20 in the URL shortens the phases (for testing).
const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
const CALIBRATION_S = Number(params.get('calib')) || 30;
const PLAY_S = Number(params.get('play')) || 300;
const STALE_MS = 3000;

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export class NeuroGame {
  constructor({ root, canvas }) {
    this.root = root;
    this.canvas = canvas;
    this.panel = root.querySelector('.game-panel');
    this.hud = root.querySelector('.game-hud');
    this.active = false;
    this.phase = 'check';
    this.sound = true;
    this.vibrate = true;
    this.override = false; // use every channel even if some are bad
    this.frame = null;
    this.lastFrameAt = 0;
    this.shownKey = '';
    this.scene = new Scene();

    root.querySelector('[data-game-close]').addEventListener('click', () => this.close());
    this.panel.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'start') this.startCalibration();
      else if (act === 'override') { this.override = !this.override; this.shownKey = ''; this.renderCheck(); }
      else if (act === 'again') { this.phase = 'check'; this.shownKey = ''; this.renderCheck(); }
      else if (act === 'close') this.close();
    });
    this.panel.addEventListener('change', (e) => {
      if (e.target.id === 'game-sound') this.sound = e.target.checked;
      if (e.target.id === 'game-vibrate') this.vibrate = e.target.checked;
    });
  }

  open(connected) {
    this.active = true;
    this.connected = connected;
    this.root.hidden = false;
    this.phase = 'check';
    this.shownKey = '';
    this.override = false;
    this.lastTick = performance.now();
    this.renderCheck();
    this.raf = requestAnimationFrame((t) => this.loop(t));
  }

  close() {
    this.active = false;
    this.root.hidden = true;
    cancelAnimationFrame(this.raf);
    this.stopAudio();
  }

  // Called twice per second by the app with the latest window of every channel.
  // frame: { channels: [{ powers, hfDb } | null], states: [...], movement }
  onFrame(frame) {
    this.frame = frame;
    this.lastFrameAt = performance.now();
    if (this.phase === 'check') this.renderCheck();
    else if (this.phase === 'calibrate') this.collect(frame);
    else if (this.phase === 'play') this.playFrame(frame);
  }

  // ---- phases ----
  get chosen() {
    const states = this.frame?.states ?? [null, null, null, null];
    const s = suggestChannels(states);
    if (!this.override) return s;
    const use = [0, 1, 2, 3];
    return { use, ignore: [], mode: use.some((ch) => EEG_POSTERIOR.includes(ch)) ? 'alpha' : 'relax' };
  }

  renderCheck() {
    if (this.phase !== 'check') return;
    const states = this.frame?.states ?? [null, null, null, null];
    const s = this.chosen;
    const key = `${states.join()}|${this.override}|${this.connected}|${this.error ?? ''}`;
    if (key === this.shownKey) return;
    this.shownKey = key;

    const chips = states.map((st, ch) => `<span class="chip ${st ?? ''}">${NAMES[ch]} ${STATE_LABEL[st] ?? 'aguardando'}</span>`).join('');
    const bad = states.map((st, ch) => (st === 'good' || st === null ? null : NAMES[ch])).filter(Boolean);
    const unknown = states.some((st) => st === null);
    let msg;
    if (!this.connected) msg = 'Conecte o Muse primeiro e volte aqui.';
    else if (unknown) msg = 'Verificando os sensores… espere alguns segundos.';
    else if (bad.length === 0) msg = 'Todos os sensores estão bons. Vamos usar todos!';
    else if (this.override) msg = `Usando todos os sensores mesmo com ${bad.join(', ')} ruim.`;
    else if (s.mode === 'none') msg = 'Nenhum sensor está bom. Ajuste o headband (limpe a testa, afaste o cabelo atrás das orelhas) e espere 1 a 2 minutos.';
    else msg = `Sensores com problema: ${bad.join(', ')}. Sugestão: ignorar e usar ${s.use.map((c) => NAMES[c]).join(', ')}.`;
    const modeNote = s.mode === 'relax' && this.connected && !unknown
      ? '<p class="game-note">Sem sensor bom atrás das orelhas: o jogo vai medir o <b>relaxamento do rosto e do corpo</b>, não ondas cerebrais.</p>' : '';
    const canStart = this.connected && !unknown && s.mode !== 'none';
    const canOverride = this.connected && !unknown && bad.length > 0;

    this.panel.innerHTML = `
      <h2>Foguete</h2>
      <div class="chips">${chips}</div>
      <p>${this.error ? `${this.error}<br>` : ''}${msg}</p>${modeNote}
      <label class="check"><input id="game-sound" type="checkbox" ${this.sound ? 'checked' : ''}> Som</label>
      <label class="check"><input id="game-vibrate" type="checkbox" ${this.vibrate ? 'checked' : ''}> Vibração</label>
      <div class="row">
        <button class="primary" data-act="start" ${canStart ? '' : 'disabled'}>Começar</button>
        ${canOverride ? `<button data-act="override">${this.override ? 'Usar a sugestão' : 'Usar todos mesmo assim'}</button>` : ''}
        <button data-act="close">Sair</button>
      </div>
      <p class="hint">Um jogo de relaxamento para brincar, não um tratamento. Um adulto deve acompanhar.</p>`;
  }

  startCalibration() {
    const s = this.chosen;
    if (!this.connected || s.mode === 'none') return;
    this.used = s.use;
    this.error = null;
    this.baseline = new Baseline(4);
    this.phase = 'calibrate';
    this.phaseStart = performance.now();
    this.ensureAudio();
    this.panel.innerHTML = `<h2>Calibrando</h2><p>Fica paradinho, respira devagar e olha para o foguete.</p><div class="game-bar"><div id="game-progress"></div></div><p id="game-count" class="hint"></p>`;
  }

  collect(frame) {
    const features = frame.channels.map((c, ch) => (c && this.used.includes(ch) && frame.states[ch] === 'good' ? channelFeatures(c) : null));
    this.baseline.add(features, frame.movement);
  }

  finishCalibration() {
    this.baseline.finalize();
    const ready = this.baseline.ready;
    this.used = this.used.filter((ch) => ready[ch]);
    if (this.used.length === 0) {
      this.error = 'A calibração não teve sinal bom o bastante. Ajuste o headband e tente de novo.';
      this.phase = 'check';
      this.shownKey = '';
      this.renderCheck();
      return;
    }
    this.mode = this.used.some((ch) => EEG_POSTERIOR.includes(ch)) ? 'alpha' : 'relax';
    this.controller = new RewardController();
    this.rocket = new Rocket();
    this.stats = { total: 0, calm: 0, paused: 0 };
    this.smooth = null;
    this.target = 0.4;
    this.level = 0.4;
    this.paused = false;
    this.pauseReason = '';
    this.phase = 'play';
    this.phaseStart = performance.now();
    this.panel.innerHTML = '';
  }

  playFrame(frame) {
    const features = frame.channels.map((c, ch) => (c && this.used.includes(ch) && frame.states[ch] === 'good' ? channelFeatures(c) : null));
    const score = computeScore({
      features, states: frame.states, used: this.used, mode: this.mode, movement: frame.movement, baseline: this.baseline,
    });
    if (score === null) {
      this.paused = true;
      const st = this.baseline.stats.move;
      this.pauseReason = (frame.movement - st.m) / st.s > 6 ? 'Fica paradinho…' : 'Ajustando o sinal…';
      this.stats.paused++;
      return;
    }
    this.paused = false;
    this.smooth = this.smooth === null ? score : 0.65 * this.smooth + 0.35 * score;
    const { level } = this.controller.update(this.smooth);
    this.target = level;
    this.stats.total++;
    if (level > 0.5) this.stats.calm++;
  }

  showSummary() {
    this.phase = 'summary';
    this.setTone(0);
    this.scene.finale(performance.now(), this.rocket.missions);
    this.fanfare([523, 659, 784, 1047, 784, 1047, 1319], 0.12);
    if (this.vibrate) navigator.vibrate?.([100, 60, 100, 60, 300]);
    const { total, calm, paused } = this.stats;
    const frames = total + paused || 1;
    this.panel.innerHTML = `
      <h2>Missão cumprida!</h2>
      <p>Missões completas: <b>${this.rocket.missions}</b></p>
      <p>Tempo calmo: <b>${Math.round((100 * calm) / (total || 1))}%</b> do tempo com sinal bom</p>
      <p>Sinal pausado (movimento ou ruído): <b>${Math.round((100 * paused) / frames)}%</b></p>
      <p class="hint">Sensores usados: ${this.used.map((c) => NAMES[c]).join(', ')} · modo ${this.mode === 'alpha' ? 'ondas alfa' : 'relaxamento do rosto e do corpo'}.<br>É um jogo de relaxamento, não um tratamento.</p>
      <div class="row"><button class="primary" data-act="again">Jogar de novo</button><button data-act="close">Sair</button></div>`;
  }

  // ---- animation ----
  loop(now) {
    if (!this.active) return;
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const elapsed = (now - (this.phaseStart ?? now)) / 1000;
    this.stale = this.phase !== 'check' && now - this.lastFrameAt > STALE_MS;

    if (this.phase === 'calibrate') {
      const bar = this.panel.querySelector('#game-progress');
      if (bar) bar.style.width = `${Math.min(100, (100 * elapsed) / CALIBRATION_S)}%`;
      const count = this.panel.querySelector('#game-count');
      if (count) count.textContent = `${Math.max(0, Math.ceil(CALIBRATION_S - elapsed))} s`;
      if (elapsed >= CALIBRATION_S) this.finishCalibration();
    } else if (this.phase === 'play') {
      this.level += (this.target - this.level) * Math.min(1, dt * 3);
      if (!this.paused && !this.stale && this.rocket.step(this.level, dt) === 'mission') this.onMission(now);
      this.setTone(this.paused || this.stale ? 0 : this.level);
      this.hud.textContent = `★ ${this.rocket.missions} · ${mmss(Math.max(0, PLAY_S - elapsed))}`;
      if (elapsed >= PLAY_S) this.showSummary();
    } else {
      this.hud.textContent = '';
    }
    this.scene.update(dt, now, this.sceneState());
    this.draw(now);
    this.raf = requestAnimationFrame((t) => this.loop(t));
  }

  onMission(now) {
    this.scene.missionDone(now, this.rocket.missions);
    if (this.vibrate) navigator.vibrate?.([80, 40, 80]);
    this.fanfare([523, 659, 784, 1047], 0.11);
  }

  sceneState() {
    return {
      phase: this.phase,
      level: this.level ?? 0,
      paused: !!this.paused,
      stale: !!this.stale,
      altitude: this.rocket ? this.rocket.altitude : 0,
      message: this.pauseReason,
    };
  }

  draw(now) {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr);
    const h = Math.round(c.clientHeight * dpr);
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    this.scene.draw(c.getContext('2d'), w, h, dpr, now, this.sceneState());
  }

  // ---- sound ----
  ensureAudio() {
    if (this.audio || !this.sound) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const master = ctx.createGain();
      master.connect(ctx.destination);
      const osc = ctx.createOscillator(); // rising whistle
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(master);
      osc.start();
      const rumble = ctx.createOscillator(); // low engine rumble
      rumble.type = 'sawtooth';
      rumble.frequency.value = 55;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 220;
      const rgain = ctx.createGain();
      rgain.gain.value = 0;
      rumble.connect(lp).connect(rgain).connect(master);
      rumble.start();
      this.audio = { ctx, osc, gain, rumble, rgain, master };
    } catch { /* no audio available */ }
  }

  setTone(level) {
    if (!this.audio || !this.sound) return;
    const { ctx, osc, gain, rumble, rgain } = this.audio;
    osc.frequency.setTargetAtTime(180 + 300 * level, ctx.currentTime, 0.1);
    gain.gain.setTargetAtTime(0.03 * level, ctx.currentTime, 0.1);
    rumble.frequency.setTargetAtTime(50 + 35 * level, ctx.currentTime, 0.1);
    rgain.gain.setTargetAtTime(0.05 * level, ctx.currentTime, 0.15);
  }

  // Rising arpeggio, used for each mission and (longer) at the end.
  fanfare(notes, gap) {
    if (!this.audio || !this.sound) return;
    const { ctx, master } = this.audio;
    notes.forEach((f, i) => {
      const t = ctx.currentTime + i * gap;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + (i === notes.length - 1 ? 0.9 : 0.28));
      osc.connect(gain).connect(master);
      osc.start(t);
      osc.stop(t + 1);
    });
  }

  stopAudio() {
    try {
      this.audio?.osc.stop();
      this.audio?.rumble.stop();
      this.audio?.ctx.close();
    } catch { /* ignore */ }
    this.audio = null;
  }
}
