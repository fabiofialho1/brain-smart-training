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
