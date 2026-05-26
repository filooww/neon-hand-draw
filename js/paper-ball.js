// Процедурный «скомканный бумажный шарик» с кешированием.
// Внутренний кеш: seed → offscreen canvas с готовой картинкой шарика.
// На последующих кадрах вместо ~100 операций canvas2d делаем один drawImage.

// Псевдослучайный генератор по seed — для детерминированных линий складок.
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296);
  };
}

function _drawPaperBallProcedural(ctx, x, y, r, seed) {
  const rng = mulberry32(seed);

  // Подушка-тень снизу.
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.85, r * 0.85, r * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();

  // Силуэт: 18 точек по кругу с джиттером — нерегулярные пики смятой бумаги.
  const N = 18;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const rr = r * (0.86 + rng() * 0.18);
    pts.push({ x: x + Math.cos(a) * rr, y: y + Math.sin(a) * rr });
  }

  // JARVIS rim glow + базовая заливка.
  ctx.shadowColor = 'rgba(110,231,255,0.7)';
  ctx.shadowBlur = 6;
  const grd = ctx.createRadialGradient(
    x - r * 0.4, y - r * 0.4, r * 0.1, x, y, r
  );
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(0.55, '#dfeefb');
  grd.addColorStop(1, '#7d9db8');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < N; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;

  // Внутренние "хребты" складок — точки внутри силуэта.
  const innerN = 7;
  const innerPts = [];
  for (let i = 0; i < innerN; i++) {
    const a = rng() * Math.PI * 2;
    const rr = r * (0.18 + rng() * 0.45);
    innerPts.push({ x: x + Math.cos(a) * rr, y: y + Math.sin(a) * rr });
  }

  // Грани (фасеты): треугольники между двумя соседними контурными точками
  // и одной внутренней. Цвет варьируется по псевдо-нормали к свету (вверх-влево).
  for (let i = 0; i < N; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % N];
    const p3 = innerPts[i % innerN];
    const mx = (p1.x + p2.x + p3.x) / 3;
    const my = (p1.y + p2.y + p3.y) / 3;
    const nx = mx - x, ny = my - y;
    const nl = Math.hypot(nx, ny) || 1;
    const lit = -(nx + ny) / (nl * Math.SQRT2); // -1..+1
    const k = Math.max(0, Math.min(1, 0.5 + lit * 0.55));
    const base = Math.round(150 + k * 105);  // 150..255
    const r0 = base, g0 = Math.min(255, base + 4), b0 = Math.min(255, base + 12);
    ctx.fillStyle = `rgba(${r0},${g0},${b0},0.92)`;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.closePath();
    ctx.fill();
  }

  // Линии складок: от точек контура к внутренним хребтам — тонкие тёмные.
  ctx.strokeStyle = 'rgba(40,70,100,0.55)';
  ctx.lineWidth = 0.8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const p1 = pts[i];
    const p3 = innerPts[i % innerN];
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p3.x, p3.y);
  }
  ctx.stroke();

  // Внутренние "хребты" — линии между соседними внутренними точками.
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  for (let i = 0; i < innerN; i++) {
    const a = innerPts[i];
    const b = innerPts[(i + 1) % innerN];
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();

  // JARVIS-обводка по силуэту.
  ctx.strokeStyle = 'rgba(110,231,255,0.65)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < N; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.stroke();
}

// Кеш seed → готовый offscreen canvas с шариком.
const paperBallCache = new Map();

// Публичная функция: использует кеш. Если шарик с этим seed ещё не рисовали —
// создаём offscreen canvas и рендерим туда один раз. На последующих кадрах
// просто drawImage. Если r изменился — масштабируем drawImage.
export function drawPaperBall(ctx, x, y, r, seed, alpha) {
  if (alpha <= 0) return;
  let entry = paperBallCache.get(seed);
  if (!entry) {
    // Запас 30% по краям под тень и cyan-обводку.
    const size = Math.ceil(r * 2.6);
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const cctx = c.getContext('2d');
    _drawPaperBallProcedural(cctx, size / 2, size / 2, r, seed);
    entry = { baseR: r, size, canvas: c };
    paperBallCache.set(seed, entry);
  }
  const drawSize = entry.size * (r / entry.baseR);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(entry.canvas, x - drawSize / 2, y - drawSize / 2, drawSize, drawSize);
  ctx.restore();
}

// Удаляем запись из кеша — вызываем когда шарик уничтожен.
export function purgePaperBall(seed) {
  paperBallCache.delete(seed);
}

// Полная очистка кеша (например, на wipeAll).
export function clearPaperBallCache() {
  paperBallCache.clear();
}
