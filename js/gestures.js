// Геометрические утилиты для жестов и пуш-классификаторы поз руки.
// Все функции принимают массив ландмарков MediaPipe (lm[0..20] = {x,y,z}).
// Никаких DOM/canvas зависимостей здесь нет — модуль чистый, тестируемый.

// Топология MediaPipe Hands — пары соседних ландмарков (кости).
// Используется в рендере скелета.
export const HAND_BONES = [
  // большой
  [0, 1], [1, 2], [2, 3], [3, 4],
  // указательный
  [0, 5], [5, 6], [6, 7], [7, 8],
  // средний
  [5, 9], [9, 10], [10, 11], [11, 12],
  // безымянный
  [9, 13], [13, 14], [14, 15], [15, 16],
  // мизинец
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

// Ось ладони: от запястья (0) к MCP среднего пальца (9). Это "вверх" руки
// независимо от того, как она повёрнута в кадре. Все проверки пальцев
// делаем через проекцию на эту ось — тогда жест распознаётся одинаково,
// и когда рука держится прямо, и когда она наклонена/перевёрнута.
export function palmAxis(lm) {
  const w = lm[0], m = lm[9];
  const ux = m.x - w.x, uy = m.y - w.y;
  const len = Math.hypot(ux, uy) || 1e-6;
  return { wx: w.x, wy: w.y, nx: ux / len, ny: uy / len, len };
}

// Знаковая проекция точки p на ось ладони, в единицах длины ладони.
// 0 — на уровне запястья, 1 — на уровне MCP среднего пальца, >1 — дальше.
export function projOnPalm(p, ax) {
  return ((p.x - ax.wx) * ax.nx + (p.y - ax.wy) * ax.ny) / ax.len;
}

export function getFingersUp(lm) {
  const tipIdx = [4, 8, 12, 16, 20];
  const up = [false, false, false, false, false];
  const ax = palmAxis(lm);

  const fingers = [
    { tip: 8, pip: 6 },   // указательный
    { tip: 12, pip: 10 }, // средний
    { tip: 16, pip: 14 }, // безымянный
    { tip: 20, pip: 18 }, // мизинец
  ];
  fingers.forEach((f, i) => {
    // Кончик заметно дальше PIP вдоль оси ладони — палец выпрямлен.
    up[i + 1] = projOnPalm(lm[f.tip], ax) > projOnPalm(lm[f.pip], ax) + 0.05;
  });

  // Большой палец: отстоит от основания указательного.
  const thumbToIndexBase = Math.hypot(lm[4].x - lm[5].x, lm[4].y - lm[5].y);
  up[0] = thumbToIndexBase > ax.len * 0.55;

  return { up, tipIdx };
}

// СТРОГОЕ определение кулака.
// Не полагаемся на булевы флаги из getFingersUp (на границе они могут
// дрожать). Здесь делаем независимую гео-проверку:
// 1) Кончики всех 4 пальцев должны быть БЛИЖЕ к запястью, чем MCP-сустав
//    (то есть палец реально подогнут к ладони, а не торчит вбок).
// 2) Кончики должны быть НИЖЕ PIP по оси ладони с большим зазором.
// 3) Большой палец прижат: кончик 4 близко к MCP среднего пальца (9).
// Только при выполнении ВСЕХ трёх — кулак.
export function isFist(lm) {
  const ax = palmAxis(lm);
  const fingers = [
    { tip: 8,  pip: 6,  mcp: 5  },
    { tip: 12, pip: 10, mcp: 9  },
    { tip: 16, pip: 14, mcp: 13 },
    { tip: 20, pip: 18, mcp: 17 },
  ];
  for (const f of fingers) {
    const tipP = projOnPalm(lm[f.tip], ax);
    const pipP = projOnPalm(lm[f.pip], ax);
    const mcpP = projOnPalm(lm[f.mcp], ax);
    if (tipP > pipP - 0.02) return false;
    if (tipP > mcpP + 0.05) return false;
  }
  // Большой палец прижат к ладони
  const thumbToPalm = Math.hypot(lm[4].x - lm[9].x, lm[4].y - lm[9].y);
  if (thumbToPalm > ax.len * 0.75) return false;
  return true;
}

// Трёхпальцевый щепок: кончики большого (4), указательного (8) и среднего (12)
// близко друг к другу. Нормируем по длине ладони — пороги не зависят от
// расстояния руки до камеры.
export function isThreeFingerPinch(lm) {
  const ax = palmAxis(lm);
  if (ax.len < 1e-3) return false;
  const t = lm[4], i = lm[8], m = lm[12];
  const d1 = Math.hypot(t.x - i.x, t.y - i.y) / ax.len;
  const d2 = Math.hypot(t.x - m.x, t.y - m.y) / ax.len;
  const d3 = Math.hypot(i.x - m.x, i.y - m.y) / ax.len;
  return d1 < 0.27 && d2 < 0.30 && d3 < 0.22;
}

// Пятипальцевое "комкание": все 5 кончиков сходятся в одну точку.
// Отличается от кулака тем, что в кулаке кончики разнесены по ладони,
// а в 5-pinch — собраны вместе.
export function isFiveFingerPinch(lm) {
  const ax = palmAxis(lm);
  if (ax.len < 1e-3) return false;
  const tips = [lm[4], lm[8], lm[12], lm[16], lm[20]];
  let cx = 0, cy = 0;
  for (const t of tips) { cx += t.x; cy += t.y; }
  cx /= 5; cy /= 5;
  let maxD = 0;
  for (const t of tips) {
    const d = Math.hypot(t.x - cx, t.y - cy);
    if (d > maxD) maxD = d;
  }
  return (maxD / ax.len) < 0.25;
}

// Угол вращения ладони — вектор от MCP указательного к MCP мизинца.
// Используется для вращения захваченного фрагмента.
export function palmRotation(lm) {
  const a = lm[5], b = lm[17];
  return Math.atan2(b.y - a.y, b.x - a.x);
}

// СТРОГОЕ определение открытой ладони: все 5 пальцев выпрямлены и торчат
// от запястья.
export function isOpenPalm(lm) {
  const ax = palmAxis(lm);
  const fingers = [
    { tip: 8,  pip: 6  },
    { tip: 12, pip: 10 },
    { tip: 16, pip: 14 },
    { tip: 20, pip: 18 },
  ];
  for (const f of fingers) {
    if (projOnPalm(lm[f.tip], ax) <= projOnPalm(lm[f.pip], ax) + 0.10) return false;
  }
  const thumbToIndexBase = Math.hypot(lm[4].x - lm[5].x, lm[4].y - lm[5].y);
  if (thumbToIndexBase <= ax.len * 0.55) return false;
  return true;
}

// Жёсткий «растопыренный» вариант ладони — для ластика.
// Все 4 пальца должны быть СИЛЬНО выпрямлены (порог 0.18 вместо 0.10),
// большой явно отведён, и расстояние между соседними кончиками не слишком
// маленькое (пальцы реально разведены, а не слипшиеся в «ребро»).
export function isSpreadPalm(lm) {
  const ax = palmAxis(lm);
  const fingers = [
    { tip: 8,  pip: 6  },
    { tip: 12, pip: 10 },
    { tip: 16, pip: 14 },
    { tip: 20, pip: 18 },
  ];
  for (const f of fingers) {
    if (projOnPalm(lm[f.tip], ax) <= projOnPalm(lm[f.pip], ax) + 0.18) return false;
  }
  const thumbToIndexBase = Math.hypot(lm[4].x - lm[5].x, lm[4].y - lm[5].y);
  if (thumbToIndexBase <= ax.len * 0.70) return false;
  const minGap = ax.len * 0.30;
  const pairs = [[8, 12], [12, 16], [16, 20]];
  for (const [a, b] of pairs) {
    if (Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y) < minGap) return false;
  }
  return true;
}
