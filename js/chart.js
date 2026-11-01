// Minimal canvas renderer: stacked lanes that scroll with the newest sample on the right.

const GRID = 'rgba(255,255,255,0.10)';
const LABEL = 'rgba(255,255,255,0.65)';

// lanes: [{ label, data, scale, color, unit }]; `capacity` = samples that fill the full width.
export function drawLanes(canvas, lanes, capacity) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (!w || !h) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const laneH = h / lanes.length;
  const step = w / (capacity - 1);
  ctx.font = `${11 * dpr}px system-ui, sans-serif`;
  ctx.lineWidth = 1.25 * dpr;
  ctx.lineJoin = 'round';

  lanes.forEach((lane, i) => {
    const top = i * laneH;
    const mid = top + laneH / 2;

    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, top + 0.5);
    ctx.lineTo(w, top + 0.5);
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    const n = lane.data.length;
    ctx.strokeStyle = lane.color;
    ctx.lineWidth = 1.25 * dpr;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const x = w - (n - 1 - k) * step;
      const norm = Math.max(-1, Math.min(1, lane.data[k] / lane.scale));
      const y = mid - norm * laneH * 0.46;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = lane.color;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(lane.label, 6 * dpr, top + 4 * dpr);
    ctx.fillStyle = LABEL;
    ctx.textAlign = 'right';
    ctx.fillText(`±${formatScale(lane.scale)} ${lane.unit}`, w - 6 * dpr, top + 4 * dpr);
  });
}

function formatScale(v) {
  if (v >= 10000) return `${Math.round(v / 1000)}k`;
  return v >= 100 ? String(Math.round(v)) : v.toPrecision(2);
}

// Axis range rounded outward to multiples of `step` (at least two steps tall).
export function niceRange(min, max, step = 3) {
  const lo = Math.floor((min - 0.5) / step) * step;
  let hi = Math.ceil((max + 0.5) / step) * step;
  if (hi - lo < 2 * step) hi = lo + 2 * step;
  return { lo, hi, step };
}

function ago(seconds) {
  if (seconds === 0) return 'agora';
  return seconds >= 60 && seconds % 60 === 0 ? `-${seconds / 60} min` : `-${seconds} s`;
}

// Band power over time. `history`: [{ t (ms), db: number[] | null }] (null = gap);
// `bands`: [{ label, color }]; `visible`: Set of band indexes.
export function drawBandChart(canvas, { history, bands, visible, now, windowMs }) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (!w || !h) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.font = `${11 * dpr}px system-ui, sans-serif`;

  const left = 44 * dpr;
  const right = 8 * dpr;
  const top = 8 * dpr;
  const bottom = 22 * dpr;
  const plotW = w - left - right;
  const plotH = h - top - bottom;
  const t0 = now - windowMs;
  const points = history.filter((p) => p.t >= t0);

  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (!p.db) continue;
    for (const i of visible) {
      min = Math.min(min, p.db[i]);
      max = Math.max(max, p.db[i]);
    }
  }
  const empty = !Number.isFinite(min);
  const { lo, hi, step } = empty ? { lo: -3, hi: 12, step: 3 } : niceRange(min, max);
  const x = (t) => left + ((t - t0) / windowMs) * plotW;
  const y = (v) => top + (1 - (v - lo) / (hi - lo)) * plotH;

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.lineWidth = 1;
  for (let v = lo; v <= hi + 1e-9; v += step) {
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(left, y(v));
    ctx.lineTo(w - right, y(v));
    ctx.stroke();
    ctx.fillStyle = LABEL;
    ctx.fillText(`${v} dB`, left - 6 * dpr, y(v));
  }
  ctx.textBaseline = 'top';
  const tickEvery = windowMs <= 60000 ? 15 : windowMs <= 300000 ? 60 : 120;
  for (let s = 0; s <= windowMs / 1000 + 1e-9; s += tickEvery) {
    const px = x(now - s * 1000);
    ctx.textAlign = s === 0 ? 'right' : s === windowMs / 1000 ? 'left' : 'center';
    ctx.fillStyle = LABEL;
    ctx.fillText(ago(s), px, h - bottom + 5 * dpr);
  }

  if (empty) {
    ctx.fillStyle = LABEL;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Aguardando dados…', left + plotW / 2, top + plotH / 2);
    return;
  }

  ctx.lineWidth = 1.75 * dpr;
  ctx.lineJoin = 'round';
  for (const i of visible) {
    ctx.strokeStyle = bands[i].color;
    ctx.beginPath();
    let pen = false;
    for (const p of points) {
      if (!p.db) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(x(p.t), y(p.db[i]));
      else ctx.moveTo(x(p.t), y(p.db[i]));
      pen = true;
    }
    ctx.stroke();
  }
}
