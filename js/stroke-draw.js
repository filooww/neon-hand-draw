// Гладкий неоновый штрих через Catmull-Rom → кубический Безье.
// Рисуется как ОДНА непрерывная Path2D — никаких стыков, никакого
// накопления shadowBlur, идеально гладкая линия.

export function drawCatmullStroke(targetCtx, points, color) {
  if (!points || points.length < 2) return;
  const path = new Path2D();
  path.moveTo(points[0].x, points[0].y);
  if (points.length === 2) {
    path.lineTo(points[1].x, points[1].y);
  } else {
    // Catmull-Rom через все точки: P[i-1], P[i], P[i+1], P[i+2]
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;
      // Tension 0.5 → стандартный Catmull-Rom.
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      path.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
    }
  }
  targetCtx.save();
  targetCtx.lineCap = 'round';
  targetCtx.lineJoin = 'round';
  // Внешний halo: толстый полупрозрачный — стабильный неон-эффект
  // без накопления shadowBlur на стыках сегментов.
  targetCtx.strokeStyle = color;
  targetCtx.globalAlpha = 0.18;
  targetCtx.lineWidth = 10;
  targetCtx.stroke(path);
  // Основной цветной слой
  targetCtx.globalAlpha = 1;
  targetCtx.lineWidth = 4;
  targetCtx.stroke(path);
  // Белая сердцевина
  targetCtx.strokeStyle = 'rgba(255,255,255,0.85)';
  targetCtx.lineWidth = 1.5;
  targetCtx.stroke(path);
  targetCtx.restore();
}
