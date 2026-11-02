// Visuals of the rocket game: the rocket stays near the middle while the world rushes past
// (clouds, stars, speed lines), the sky goes from day to space, and missions end with fireworks.
// Pure canvas drawing; all state is passed in, nothing here touches the sensors.

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rnd = (a, b) => a + Math.random() * (b - a);
const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (c1, c2, t) => c1.map((v, i) => lerp(v, c2[i], t));

// Sky colours by mission altitude (0 = launch pad in daylight, 1 = deep space).
const SKY = [
  { at: 0, top: [95, 170, 235], bottom: [205, 232, 250] },
  { at: 0.3, top: [40, 100, 190], bottom: [130, 180, 230] },
  { at: 0.55, top: [15, 30, 100], bottom: [70, 60, 140] },
  { at: 0.8, top: [6, 8, 40], bottom: [22, 20, 72] },
  { at: 1, top: [3, 3, 20], bottom: [10, 8, 40] },
];

function skyAt(alt) {
  for (let i = 1; i < SKY.length; i++) {
    if (alt <= SKY[i].at) {
      const t = (alt - SKY[i - 1].at) / (SKY[i].at - SKY[i - 1].at);
      return { top: mix(SKY[i - 1].top, SKY[i].top, t), bottom: mix(SKY[i - 1].bottom, SKY[i].bottom, t) };
    }
  }
  return SKY[SKY.length - 1];
}

const CONFETTI = ['#ff5964', '#ffe66d', '#4ecdc4', '#6a8cff', '#ff9f1c', '#c77dff'];
const MAX_PARTICLES = 420;

// Draws centred bold text no wider than `maxWidth`, shrinking the font if needed.
function fitText(ctx, text, x, y, size, maxWidth, bold = true) {
  ctx.font = `${bold ? 'bold ' : ''}${size}px system-ui, sans-serif`;
  const width = ctx.measureText(text).width;
  if (width > maxWidth) ctx.font = `${bold ? 'bold ' : ''}${(size * maxWidth) / width}px system-ui, sans-serif`;
  ctx.fillText(text, x, y);
}

export class Scene {
  constructor() {
    this.speed = 0; // 0..1, how fast the world rushes by
    this.flight = 0; // 0 on the pad .. 1 flying
    this.clouds = Array.from({ length: 9 }, () => ({ x: Math.random(), y: Math.random(), s: rnd(0.6, 1.5), f: rnd(0.5, 1.2) }));
    this.stars = Array.from({ length: 100 }, () => ({ x: Math.random(), y: Math.random(), r: rnd(0.4, 1.9), layer: Math.random() < 0.5 ? 0 : 1, tw: rnd(0, 6) }));
    this.streaks = Array.from({ length: 18 }, () => ({ x: Math.random(), y: Math.random(), len: rnd(0.05, 0.16) }));
    this.sparks = [];
    this.smoke = [];
    this.confetti = [];
    this.bursts = [];
    this.flashUntil = 0;
    this.finaleUntil = 0;
    this.nextBurst = 0;
    this.banner = '';
    this.size = { w: 0, h: 0, dpr: 1 };
    this.nozzle = null;
    this.emit = 0;
  }

  missionDone(now, count) {
    this.flashUntil = now + 3000;
    this.banner = `Missão ${count} cumprida!`;
    this.spawnConfetti(110, true);
    for (let i = 0; i < 3; i++) this.spawnBurst(rnd(0.2, 0.8), rnd(0.15, 0.4));
  }

  finale(now, missions) {
    this.finaleUntil = now + 9000;
    this.finaleMissions = missions;
    this.nextBurst = now;
    this.spawnConfetti(160, true);
  }

  spawnConfetti(n, burst = false) {
    const { w, h, dpr } = this.size;
    if (!w) return;
    for (let i = 0; i < n && this.confetti.length < MAX_PARTICLES; i++) {
      this.confetti.push({
        x: burst ? w / 2 + rnd(-w * 0.35, w * 0.35) : rnd(0, w), y: burst ? h * 0.3 : -10 * dpr,
        vx: rnd(-120, 120) * dpr, vy: burst ? rnd(-520, -120) * dpr : rnd(80, 220) * dpr,
        rot: rnd(0, 6.3), vr: rnd(-8, 8), color: CONFETTI[(Math.random() * CONFETTI.length) | 0],
        w: rnd(6, 12) * dpr, h: rnd(3, 6) * dpr, life: rnd(2.5, 4),
      });
    }
  }

  spawnBurst(fx, fy) {
    const { w, h, dpr } = this.size;
    if (!w) return;
    const color = CONFETTI[(Math.random() * CONFETTI.length) | 0];
    for (let i = 0; i < 36 && this.bursts.length < MAX_PARTICLES; i++) {
      const a = (i / 36) * Math.PI * 2 + rnd(-0.1, 0.1);
      const v = rnd(120, 330) * dpr;
      this.bursts.push({ x: fx * w, y: fy * h, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rnd(0.8, 1.4), max: 1.4, color });
    }
  }

  // s: { phase, level, paused, stale, altitude }
  update(dt, now, s) {
    const moving = s.phase === 'play' && !s.paused && !s.stale;
    const targetSpeed = moving ? clamp((s.level - 0.25) / 0.75, 0, 1) : s.phase === 'summary' ? 0.6 : 0;
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * 2.2);
    const flightTarget = s.phase === 'play' ? (moving ? 1 : 0.55) : s.phase === 'summary' ? 1 : 0;
    this.flight += (flightTarget - this.flight) * Math.min(1, dt * 1.4);

    for (const c of this.clouds) {
      c.y += (this.speed * 0.9 * c.f + 0.01) * dt;
      if (c.y > 1.2) { c.y = -0.2; c.x = Math.random(); }
    }
    for (const st of this.stars) {
      st.y += this.speed * (st.layer ? 0.9 : 0.35) * dt;
      if (st.y > 1) { st.y -= 1; st.x = Math.random(); }
    }
    for (const sk of this.streaks) {
      sk.y += this.speed * 2.4 * dt;
      if (sk.y - sk.len > 1) { sk.y = -0.05; sk.x = Math.random(); }
    }

    // Exhaust: sparks and smoke, proportional to the effort level.
    const { dpr } = this.size;
    if (this.nozzle && this.flight > 0.3) {
      const power = moving ? s.level : 0.15;
      this.emit += power * 70 * dt;
      while (this.emit >= 1 && this.sparks.length < MAX_PARTICLES) {
        this.emit -= 1;
        this.sparks.push({ x: this.nozzle.x + rnd(-8, 8) * dpr, y: this.nozzle.y, vx: rnd(-60, 60) * dpr, vy: rnd(220, 520) * dpr * (0.6 + power), life: rnd(0.35, 0.8), max: 0.8 });
        if (Math.random() < 0.35 && this.smoke.length < MAX_PARTICLES) {
          this.smoke.push({ x: this.nozzle.x + rnd(-12, 12) * dpr, y: this.nozzle.y + rnd(0, 30) * dpr, vx: rnd(-40, 40) * dpr, vy: rnd(80, 200) * dpr, r: rnd(8, 16) * dpr, life: rnd(0.8, 1.5), max: 1.5 });
        }
      }
    }
    const step = (list, fn) => { for (let i = list.length - 1; i >= 0; i--) { if (fn(list[i]) || list[i].life <= 0) list.splice(i, 1); } };
    step(this.sparks, (p) => { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; });
    step(this.smoke, (p) => { p.x += p.vx * dt; p.y += p.vy * dt; p.r += 9 * dpr * dt; p.life -= dt; });
    step(this.confetti, (p) => { p.vy += 260 * dpr * dt; p.vx *= 0.995; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt; p.life -= dt; return p.y > this.size.h + 20; });
    step(this.bursts, (p) => { p.vy += 180 * dpr * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; });

    if (now < this.finaleUntil) { // keep the party going
      if (Math.random() < dt * 14) this.spawnConfetti(1);
      if (now >= this.nextBurst) { this.spawnBurst(rnd(0.15, 0.85), rnd(0.12, 0.45)); this.nextBurst = now + rnd(500, 900); }
    }
  }

  draw(ctx, w, h, dpr, now, s) {
    this.size = { w, h, dpr };
    const alt = s.altitude;
    const u = Math.min(w, h) / 14;
    const moving = s.phase === 'play' && !s.paused && !s.stale;
    const level = moving ? s.level : s.phase === 'summary' ? 0.8 : 0;

    // sky
    const sky = skyAt(alt);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, rgb(sky.top));
    g.addColorStop(1, rgb(sky.bottom));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // sun by day, planets near space
    if (alt < 0.55) {
      ctx.fillStyle = `rgba(255, 236, 160, ${1 - alt / 0.55})`;
      ctx.beginPath();
      ctx.arc(w * 0.78, h * (0.16 + alt * 0.7), u * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    if (alt > 0.5) {
      const t = clamp((alt - 0.5) / 0.5, 0, 1);
      ctx.fillStyle = `rgba(224, 112, 74, ${t})`; // orange planet, grows as the goal gets close
      ctx.beginPath();
      ctx.arc(w * 0.2, h * (0.95 - t * 0.75), u * (1.4 + t * 3.6), 0, Math.PI * 2);
      ctx.fill();
      if (alt > 0.7) {
        const t2 = clamp((alt - 0.7) / 0.3, 0, 1);
        const px = w * 0.8;
        const py = h * (0.9 - t2 * 0.7);
        const r = u * (0.8 + t2 * 2.2);
        ctx.fillStyle = `rgba(150, 120, 230, ${t2})`;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(230, 210, 255, ${t2})`;
        ctx.lineWidth = 3 * dpr;
        ctx.beginPath();
        ctx.ellipse(px, py, r * 1.7, r * 0.45, -0.4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // stars (streaks when fast)
    const starAlpha = clamp((alt - 0.3) / 0.4, 0, 1);
    if (starAlpha > 0) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#fff';
      for (const st of this.stars) {
        const a = starAlpha * (0.6 + 0.4 * Math.sin(now / 400 + st.tw));
        ctx.globalAlpha = a;
        const x = st.x * w;
        const y = st.y * h;
        const trail = this.speed * (st.layer ? 46 : 18) * dpr;
        if (trail > 3 * dpr) {
          ctx.lineWidth = st.r * dpr;
          ctx.beginPath();
          ctx.moveTo(x, y - trail);
          ctx.lineTo(x, y);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, st.r * dpr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    // clouds
    const cloudAlpha = clamp(1 - alt * 1.7, 0, 1) * 0.9;
    if (cloudAlpha > 0.02) {
      ctx.fillStyle = `rgba(255,255,255,${cloudAlpha})`;
      for (const c of this.clouds) {
        const x = c.x * w;
        const y = c.y * h;
        const r = u * 0.9 * c.s;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.arc(x + r * 1.1, y + r * 0.15, r * 0.8, 0, Math.PI * 2);
        ctx.arc(x - r * 1.1, y + r * 0.2, r * 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // speed lines
    if (this.speed > 0.15) {
      ctx.strokeStyle = `rgba(255,255,255,${0.12 + 0.3 * this.speed})`;
      ctx.lineWidth = 2 * dpr;
      for (const sk of this.streaks) {
        ctx.beginPath();
        ctx.moveTo(sk.x * w, (sk.y - sk.len * (0.5 + this.speed)) * h);
        ctx.lineTo(sk.x * w, sk.y * h);
        ctx.stroke();
      }
    }

    // ground, hills and launch tower: they fall away as the rocket lifts off
    const groundY = h * 0.86 + this.flight * h * 0.55 + alt * h * 0.5;
    if (groundY < h + 40) {
      for (const [color, amp, phase, base] of [['#4f8a5f', 0.035, 1.3, 0.05], ['#2f6a43', 0.03, 0, 0]]) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(0, h + 5);
        for (let x = 0; x <= w; x += 16 * dpr) ctx.lineTo(x, groundY - h * base - (Math.sin(x * 0.004 / dpr + phase) * 0.5 + 0.5) * h * amp);
        ctx.lineTo(w, h + 5);
        ctx.fill();
      }
      ctx.fillStyle = '#8a8f99'; // launch tower
      ctx.fillRect(w / 2 + u * 2.2, groundY - u * 5, u * 0.5, u * 5);
      ctx.fillRect(w / 2 + u * 1.4, groundY - u * 4.6, u * 0.9, u * 0.25);
    }

    // rocket position: on the pad at first, then up near the middle
    const restCy = h * 0.86 - u * 3.1;
    const flyCy = h * 0.52;
    const f = this.flight * this.flight * (3 - 2 * this.flight);
    const shake = level > 0.6 && f > 0.5 ? (level - 0.6) * 5 * dpr : 0;
    const cx = w / 2 + (s.paused || s.stale ? Math.sin(now / 90) * 2 * dpr : (Math.random() - 0.5) * shake);
    const cy = lerp(restCy, flyCy, f) + (f > 0.8 ? Math.sin(now / 500) * u * 0.12 : 0) + (Math.random() - 0.5) * shake;
    this.nozzle = { x: cx, y: cy + u * 2.45 };

    // smoke and sparks behind the rocket
    for (const p of this.smoke) {
      ctx.fillStyle = `rgba(210,210,220,${0.2 * (p.life / p.max)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    this.drawRocket(ctx, cx, cy, u, dpr, now, s, level);
    for (const p of this.sparks) {
      const t = p.life / p.max;
      ctx.fillStyle = t > 0.5 ? `rgba(255,${(200 * t) | 0},60,${t})` : `rgba(255,90,30,${t * 1.4})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, (2 + 3 * t) * dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    // mission progress bar on the right
    if (s.phase === 'play') {
      const bx = w - 20 * dpr;
      const top = h * 0.18;
      const bottom = h * 0.78;
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(bx - 5 * dpr, top, 10 * dpr, bottom - top);
      ctx.fillStyle = '#ffe66d';
      ctx.fillRect(bx - 5 * dpr, bottom - (bottom - top) * alt, 10 * dpr, (bottom - top) * alt);
      ctx.beginPath();
      ctx.arc(bx, bottom - (bottom - top) * alt, 9 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `${18 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('★', bx, top - 8 * dpr);
    }

    // fireworks and confetti on top
    for (const p of this.bursts) {
      ctx.fillStyle = p.color;
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const p of this.confetti) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }

    // messages
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 8 * dpr;
    if (now < this.finaleUntil) {
      const pulse = 1 + 0.05 * Math.sin(now / 160);
      fitText(ctx, 'Missão cumprida!', w / 2, h * 0.16, 46 * dpr * pulse, w * 0.9);
      const n = this.finaleMissions;
      fitText(ctx, n > 0 ? `${'★'.repeat(Math.min(n, 8))}  ${n} ${n === 1 ? 'missão' : 'missões'}` : 'Você decolou! Continue treinando!',
        w / 2, h * 0.16 + 38 * dpr, 22 * dpr, w * 0.9, false);
    } else if (s.phase === 'play' && now < this.flashUntil) {
      const pulse = 1 + 0.06 * Math.sin(now / 120);
      fitText(ctx, `★ ${this.banner} ★`, w / 2, h * 0.16, 38 * dpr * pulse, w * 0.9);
    } else if (s.phase === 'play' && (s.paused || s.stale)) {
      fitText(ctx, s.stale ? 'Sem sinal do Muse…' : s.message, w / 2, h * 0.16, 22 * dpr, w * 0.9, false);
    }
    ctx.shadowBlur = 0;
  }

  drawRocket(ctx, cx, cy, u, dpr, now, s, level) {
    // flame: three layers, longer and wilder with more effort
    const flying = this.flight > 0.15;
    const power = flying ? Math.max(level, s.paused ? 0.18 : 0.05) : 0;
    if (power > 0.02) {
      const flick = 0.85 + 0.15 * Math.sin(now / 55) + 0.08 * Math.sin(now / 23);
      const len = u * (1.2 + 5.2 * power) * flick;
      const y0 = cy + u * 2.3;
      if (power > 0.5) { // glow
        const glow = ctx.createRadialGradient(cx, y0 + len * 0.3, 0, cx, y0 + len * 0.3, u * 4.5 * power);
        glow.addColorStop(0, 'rgba(255,200,80,0.45)');
        glow.addColorStop(1, 'rgba(255,120,0,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(cx - u * 5, y0 - u, u * 10, len + u * 5);
      }
      for (const [wd, ln, color] of [[0.85, 1, 'rgba(255,110,20,0.95)'], [0.55, 0.72, 'rgba(255,200,60,0.97)'], [0.28, 0.45, 'rgba(255,255,230,1)']]) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(cx - u * wd, y0);
        ctx.quadraticCurveTo(cx - u * wd * 0.6, y0 + len * ln * 0.6, cx, y0 + len * ln);
        ctx.quadraticCurveTo(cx + u * wd * 0.6, y0 + len * ln * 0.6, cx + u * wd, y0);
        ctx.fill();
      }
    }
    ctx.fillStyle = '#d33'; // fins
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + side * u * 1.2, cy + u * 2.5);
      ctx.lineTo(cx + side * u * 2.1, cy + u * 3.1);
      ctx.lineTo(cx + side * u * 1.0, cy + u * 1.2);
      ctx.fill();
    }
    ctx.fillStyle = '#f2f4f8'; // body
    ctx.beginPath();
    ctx.ellipse(cx, cy + u * 1.1, u * 1.25, u * 2.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d33'; // nose
    ctx.beginPath();
    ctx.moveTo(cx - u * 0.95, cy - u * 0.4);
    ctx.quadraticCurveTo(cx, cy - u * 2.6, cx + u * 0.95, cy - u * 0.4);
    ctx.fill();
    ctx.fillStyle = '#4fb3d9'; // window
    ctx.beginPath();
    ctx.arc(cx, cy + u * 0.7, u * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
}
