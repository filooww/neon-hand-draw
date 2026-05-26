// Геометрия штрихов и простой классификатор фигур.
// Принимаем штрих как { color, points: [{x,y}, ...] } и возвращаем
// либо { kind: 'line'|'circle'|'rect', ... }, либо null.

export function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

export function strokeBBox(stroke) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of stroke.points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

export function strokesBBox(strokes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    const b = strokeBBox(s);
    if (b.minX < minX) minX = b.minX;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// Пересэмплирование штриха в N равноудалённых точек — нужно для
// устойчивого подсчёта углов на штрихах с неравномерной плотностью точек.
export function resampleStroke(points, n) {
  if (points.length < 2) return points.slice();
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  if (total === 0) return points.slice();
  const step = total / (n - 1);
  const out = [points[0]];
  let acc = 0;
  let prev = points[0];
  for (let i = 1; i < points.length; i++) {
    const curr = points[i];
    let d = dist(prev, curr);
    while (acc + d >= step && out.length < n) {
      const t = (step - acc) / d;
      const np = { x: prev.x + t * (curr.x - prev.x), y: prev.y + t * (curr.y - prev.y) };
      out.push(np);
      prev = np;
      d = dist(prev, curr);
      acc = 0;
    }
    acc += d;
    prev = curr;
  }
  while (out.length < n) out.push(points[points.length - 1]);
  return out;
}

export function countCorners(pts) {
  let corners = 0;
  const win = 3;
  let lastIdx = -10;
  for (let i = win; i < pts.length - win; i++) {
    const a = pts[i - win], b = pts[i], c = pts[i + win];
    const v1x = b.x - a.x, v1y = b.y - a.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
    if (m1 === 0 || m2 === 0) continue;
    const cos = (v1x * v2x + v1y * v2y) / (m1 * m2);
    if (cos < 0.35 && i - lastIdx > win * 2) {
      corners++;
      lastIdx = i;
    }
  }
  return corners;
}

// Геометрический классификатор: круг / линия / прямоугольник.
export function recognizeShape(stroke) {
  const pts = stroke.points;
  if (pts.length < 8) return null;
  const bbox = strokeBBox(stroke);
  const diag = Math.hypot(bbox.w, bbox.h);
  if (diag < 40) return null;

  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  if (L < 30) return null;

  // 1) ЛИНИЯ: длина прямой почти равна длине штриха.
  const a = pts[0], b = pts[pts.length - 1];
  const lineLen = dist(a, b);
  if (lineLen / L > 0.92 && lineLen > 50) {
    return { kind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }

  const closed = lineLen < diag * 0.30;
  if (!closed) return null;

  // Площадь по формуле шнурков
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i], p2 = pts[(i + 1) % pts.length];
    area += p1.x * p2.y - p2.x * p1.y;
  }
  area = Math.abs(area) / 2;
  if (area < 100) return null;

  const perim = L;
  const roundness = (4 * Math.PI * area) / (perim * perim);
  const aspect = Math.min(bbox.w, bbox.h) / Math.max(bbox.w, bbox.h);

  // 2) КРУГ: высокий roundness и почти квадратный bbox.
  if (roundness > 0.78 && aspect > 0.7) {
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    const r = (bbox.w + bbox.h) / 4;
    return { kind: 'circle', cx, cy, r };
  }

  // 3) ПРЯМОУГОЛЬНИК: 3–5 углов и средний roundness.
  const corners = countCorners(resampleStroke(pts, 64));
  if (corners >= 3 && corners <= 5 && roundness > 0.55 && roundness < 0.85) {
    return { kind: 'rect', x: bbox.minX, y: bbox.minY, w: bbox.w, h: bbox.h };
  }
  return null;
}

// Рисует распознанную фигуру в стиле «неон» в указанный контекст.
export function drawCleanShape(ctx, shape, color) {
  const path = (cx) => {
    cx.beginPath();
    if (shape.kind === 'line') {
      cx.moveTo(shape.x1, shape.y1); cx.lineTo(shape.x2, shape.y2);
    } else if (shape.kind === 'circle') {
      cx.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2);
    } else if (shape.kind === 'rect') {
      cx.rect(shape.x, shape.y, shape.w, shape.h);
    }
  };
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = color; ctx.shadowBlur = 6;
  ctx.strokeStyle = color; ctx.lineWidth = 4;
  path(ctx); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.5;
  path(ctx); ctx.stroke();
  ctx.restore();
}

// Рисует распознанный текст. canvas зеркалится через CSS scaleX(-1),
// поэтому здесь пред-зеркалим, чтобы на экране читалось нормально.
export function drawCleanText(ctx, text, bbox, color) {
  const h = Math.max(28, Math.min(120, bbox.h));
  ctx.save();
  ctx.font = `600 ${Math.round(h)}px -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  ctx.fillStyle = color;
  ctx.translate(bbox.minX + bbox.w, bbox.minY + bbox.h / 2);
  ctx.scale(-1, 1);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}
