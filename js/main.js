// Главный модуль: DOM-узлы, состояние, главный цикл onResults.
// Чистые геометрические утилиты вынесены в отдельные модули и импортируются.

import {
  HAND_BONES,
  getFingersUp,
  isFist,
  isThreeFingerPinch,
  isFiveFingerPinch,
  palmRotation,
  isOpenPalm,
  isSpreadPalm,
} from './gestures.js';

import {
  strokesBBox,
  recognizeShape,
  drawCleanShape,
  drawCleanText,
} from './recognition.js';

import {
  drawPaperBall,
  purgePaperBall,
  clearPaperBallCache,
} from './paper-ball.js';

import { drawCatmullStroke } from './stroke-draw.js';
import { makeOneEuro } from './one-euro.js';
import { initHandLandmarker, startCamera, shimResults, IS_MOBILE, CAM_W, CAM_H } from './hand-tracker.js';

(async () => {
  const video = document.getElementById('cam');
  const canvas = document.getElementById('draw');   // видимый — viewport
  const wrap = document.getElementById('wrap');
  const viewCtx = canvas.getContext('2d');
  // Offscreen-холст с самим рисунком. Все штрихи и ластик пишут сюда.
  // Видимый canvas каждый кадр очищается и заново отрисовывает art с
  // текущей трансформацией (translate / scale / rotate). Это позволяет
  // двумя щепотками таскать/масштабировать ВЕСЬ рисунок без потерь.
  const artCanvas = document.createElement('canvas');
  const artCtx = artCanvas.getContext('2d');
  // Отдельный "сырой" холст для только что нарисованных штрихов.
  // Их мы прячем сюда, пока распознавание решает — это фигура, буква
  // или просто вольный рисунок. Если распознали — вытираем pending
  // и рисуем чистый результат на artCanvas. Если не распознали за
  // COMMIT_IDLE_MS — переливаем pending в art как обычный рисунок.
  const pendingCanvas = document.createElement('canvas');
  const pendingCtx = pendingCanvas.getContext('2d');
  // Live-холст для активных штрихов: каждый кадр перерисовываем весь
  // незакрытый штрих как единую Catmull-Rom кривую без shadowBlur-накопления.
  // Это даёт идеально гладкую линию без «бусинок» от инкрементальных сегментов.
  const liveCanvas = document.createElement('canvas');
  const liveCtx = liveCanvas.getContext('2d');
  const recogEl = document.getElementById('recog');
  const gestureEl = document.getElementById('gesture');
  const fpsEl = document.getElementById('fps');
  const loading = document.getElementById('loading');
  const paletteEl = document.getElementById('palette');
  const eraserSizeEl = document.getElementById('eraserSize');
  const eraserValEl = document.getElementById('eraserVal');
  const holdRing = document.getElementById('holdRing');
  const holdProgress = document.getElementById('holdProgress');

  // Ширина ластика (радиус в пикселях canvas). Управляется слайдером.
  let eraserRadius = parseInt(eraserSizeEl.value, 10);
  eraserSizeEl.addEventListener('input', () => {
    eraserRadius = parseInt(eraserSizeEl.value, 10);
    eraserValEl.textContent = eraserRadius;
  });

  const COLORS = ['#6ee7ff', '#ff6ec7', '#9d6eff', '#ffd66e', '#6eff9d', '#ff6e6e', '#ffffff'];
  let currentColor = COLORS[0];

  const paletteList = document.getElementById('paletteList');
  const paletteTrigger = document.getElementById('paletteTrigger');
  const paletteCurrent = document.getElementById('paletteCurrent');

  COLORS.forEach((c, i) => {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (i === 0 ? ' active' : '');
    sw.style.background = c;
    sw.style.color = c;
    sw.addEventListener('click', () => {
      currentColor = c;
      paletteList.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      paletteCurrent.style.background = c;
      paletteCurrent.style.color = c;
      paletteEl.classList.remove('open');
      paletteTrigger.setAttribute('aria-expanded', 'false');
    });
    paletteList.appendChild(sw);
  });

  paletteTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = paletteEl.classList.toggle('open');
    paletteTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('click', (e) => {
    if (!paletteEl.contains(e.target)) {
      paletteEl.classList.remove('open');
      paletteTrigger.setAttribute('aria-expanded', 'false');
    }
  });

  // --- Размер canvas/video: подгоняем под аспект камеры, без cover-кропа ---
  // Это критично для точности: координаты от MediaPipe нормализованы к кадру камеры.
  // Если бы мы кропали через object-fit:cover, пришлось бы пересчитывать со смещением.
  // Поэтому просто вписываем кадр в окно с сохранением аспекта.
  // 960×540 — разумный компромисс между точностью ландмарков и FPS.
  // CAM_W, CAM_H импортированы из hand-tracker.js (адаптированы под мобильные)
  const CAM_ASPECT = CAM_W / CAM_H;

  function fitWrap() {
    const winAspect = window.innerWidth / window.innerHeight;
    let w, h;
    if (winAspect > CAM_ASPECT) {
      h = window.innerHeight;
      w = h * CAM_ASPECT;
    } else {
      w = window.innerWidth;
      h = w / CAM_ASPECT;
    }
    wrap.style.width = w + 'px';
    wrap.style.height = h + 'px';
    canvas.width = w;
    canvas.height = h;
    // artCanvas синхронизирован по размеру с видимым. Сохраняем содержимое при ресайзе.
    if (artCanvas.width !== w || artCanvas.height !== h) {
      const tmp = document.createElement('canvas');
      tmp.width = artCanvas.width || w;
      tmp.height = artCanvas.height || h;
      if (artCanvas.width > 0 && artCanvas.height > 0) {
        tmp.getContext('2d').drawImage(artCanvas, 0, 0);
      }
      artCanvas.width = w;
      artCanvas.height = h;
      if (tmp.width > 0 && tmp.height > 0) {
        artCtx.drawImage(tmp, 0, 0);
      }
      // pendingCanvas синхронизируем так же.
      const tmp2 = document.createElement('canvas');
      tmp2.width = pendingCanvas.width || w;
      tmp2.height = pendingCanvas.height || h;
      if (pendingCanvas.width > 0 && pendingCanvas.height > 0) {
        tmp2.getContext('2d').drawImage(pendingCanvas, 0, 0);
      }
      pendingCanvas.width = w;
      pendingCanvas.height = h;
      if (tmp2.width > 0 && tmp2.height > 0) {
        pendingCtx.drawImage(tmp2, 0, 0);
      }
      // liveCanvas — содержимое не сохраняем, каждый кадр перерисуем.
      liveCanvas.width = w;
      liveCanvas.height = h;
    }
  }
  window.addEventListener('resize', fitWrap);
  fitWrap();

  function wipeAll() {
    artCtx.clearRect(0, 0, artCanvas.width, artCanvas.height);
    pendingCtx.clearRect(0, 0, pendingCanvas.width, pendingCanvas.height);
    liveCtx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
    recentStrokes.length = 0;
    openStrokes.clear();
    recognitionScheduled = false;
    strokesGen++;
    grabbed = null;
    // Стираем и бумажные комки, иначе они остаются висеть на экране.
    paperBalls.length = 0;
    clearPaperBallCache();
    crumpling = null;
    // Инвалидация кеша bbox — иначе hasContent ещё ~200мс будет считать «есть рисунок»
    // и ластик ложно сработает на пустом холсте сразу после очистки.
    bboxCache.stamp = 0;
    bboxCache.value = null;
    resetTransform();
    setRecogStatus('STAND BY');
  }

  document.getElementById('clear').addEventListener('click', wipeAll);

  // Stream-mode: Cmd/Ctrl + H прячет весь UI и рамки HUD.
  // Удобно перед стримом / OBS захватом окна — остаётся чистое видео + рисунки.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'h' || e.key === 'H')) {
      e.preventDefault();
      document.body.classList.toggle('stream-mode');
    }
  });

  document.getElementById('save').addEventListener('click', () => {
    // Объединяем art + pending + захваченный фрагмент во временный холст.
    const tmp = document.createElement('canvas');
    tmp.width = artCanvas.width;
    tmp.height = artCanvas.height;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(artCanvas, 0, 0);
    tctx.drawImage(pendingCanvas, 0, 0);
    if (grabbed) {
      tctx.save();
      tctx.translate(grabbed.pos.x, grabbed.pos.y);
      tctx.rotate(grabbed.rot);
      tctx.drawImage(grabbed.img, -grabbed.bbox.w / 2, -grabbed.bbox.h / 2);
      tctx.restore();
    }
    const link = document.createElement('a');
    link.download = 'neon-air-draw.png';
    link.href = tmp.toDataURL('image/png');
    link.click();
  });

  // Состояние "последних точек" для КАЖДОГО пальца отдельно — чтобы рисовать
  // сразу несколькими пальцами и не соединять их линии.
  const lastPoints = new Map();

  // Дебаунс для жеста "указательный". Чтобы случайные мимолётные кадры
  // (рука меняет позу, MediaPipe ошибся на один кадр) не оставляли паразитных
  // точек, требуем чтобы жест pointing продержался N кадров подряд.
  const pointingDebounce = new Map();
  const POINTING_STABLE_FRAMES = 2;
  // Грейс-период: если pointing на мгновение пропал, держим штрих открытым
  // ещё CONTINUITY_MS — чтобы линия не прерывалась.
  const STROKE_CONTINUITY_MS = 180;

  // Жест "удержание открытой ладони" для полной очистки.
  const HOLD_MS = 1000;
  let holdStart = 0;
  let holdJustFired = false;

  // Трансформация art-холста (двумя щепотками).
  const tr = { tx: 0, ty: 0, scale: 1, rot: 0 };
  let grab = null;

  // Трёхпальцевый "щепок" — захват фрагмента рисунка.
  let grabbed = null;
  const pinchDebounce = new Map();
  const PINCH_STABLE_FRAMES = 3;

  // Скомканные бумажные шарики.
  const paperBalls = [];
  let nextBallId = 1;
  let crumpling = null;
  const crumpleDebounce = new Map();
  const CRUMPLE_STABLE_FRAMES = 3;

  // Детектор жеста «🤘 rock» (коза) для смены цвета.
  const peaceState = new Map();
  const PEACE_STABLE_FRAMES = 5;
  let snapFlashUntil = 0;
  function nextColor() {
    const idx = COLORS.indexOf(currentColor);
    const nextIdx = (idx + 1) % COLORS.length;
    const c = COLORS[nextIdx];
    currentColor = c;
    paletteList.querySelectorAll('.swatch').forEach((s, i) => {
      s.classList.toggle('active', i === nextIdx);
    });
    paletteCurrent.style.background = c;
    paletteCurrent.style.color = c;
  }

  // Состояние распознавания фигур и текста.
  const recentStrokes = [];
  const openStrokes = new Map();
  let lastStrokeActivity = 0;
  let recognitionScheduled = false;
  let ocrInFlight = false;
  let strokesGen = 0;
  const RECOGNIZE_IDLE_MS = 700;
  const COMMIT_IDLE_MS = 3500;
  const OCR_MIN_CONF = 55;

  function setRecogStatus(text) { recogEl.textContent = text; }

  // Tesseract воркер — лениво и однократно.
  let tesseractWorker = null;
  let tesseractLoading = null;
  async function getTesseract() {
    if (tesseractWorker) return tesseractWorker;
    if (typeof Tesseract === 'undefined') return null;
    if (tesseractLoading) return tesseractLoading;
    setRecogStatus('LOADING MODEL');
    tesseractLoading = (async () => {
      try {
        const w = await Tesseract.createWorker(['rus', 'eng']);
        tesseractWorker = w;
        return w;
      } catch (e) {
        console.error('Tesseract init failed', e);
        return null;
      } finally {
        tesseractLoading = null;
      }
    })();
    return tesseractLoading;
  }

  async function runOcrOnStrokes(strokes) {
    const w = await getTesseract();
    if (!w) return null;
    const bbox = strokesBBox(strokes);
    if (bbox.w < 30 || bbox.h < 30) return null;
    const pad = 30;
    const W = Math.ceil(bbox.w + pad * 2), H = Math.ceil(bbox.h + pad * 2);
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const tctx = tmp.getContext('2d');
    tctx.fillStyle = '#fff';
    tctx.fillRect(0, 0, W, H);
    // Tesseract ожидает обычную ориентацию — пред-отражаем по x.
    tctx.save();
    tctx.translate(W, 0);
    tctx.scale(-1, 1);
    tctx.translate(-bbox.minX + pad, -bbox.minY + pad);
    tctx.lineCap = 'round'; tctx.lineJoin = 'round';
    tctx.strokeStyle = '#000';
    tctx.lineWidth = Math.max(6, Math.round(Math.min(bbox.w, bbox.h) / 25));
    for (const s of strokes) {
      if (s.points.length < 2) continue;
      tctx.beginPath();
      tctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) tctx.lineTo(s.points[i].x, s.points[i].y);
      tctx.stroke();
    }
    tctx.restore();
    let result;
    try { result = await w.recognize(tmp); }
    catch (e) { console.error('OCR error', e); return null; }
    const text = ((result.data && result.data.text) || '').trim().replace(/\s+/g, ' ');
    const conf = (result.data && result.data.confidence) || 0;
    return { text, conf, bbox };
  }

  function commitPending() {
    if (recentStrokes.length === 0) return;
    artCtx.drawImage(pendingCanvas, 0, 0);
    pendingCtx.clearRect(0, 0, pendingCanvas.width, pendingCanvas.height);
    recentStrokes.length = 0;
    strokesGen++;
    setRecogStatus('STAND BY');
  }

  async function tryRecognize() {
    if (recentStrokes.length === 0) { recognitionScheduled = false; return; }
    if (openStrokes.size > 0) { recognitionScheduled = false; return; }

    // 1) Один штрих → пробуем фигуру.
    if (recentStrokes.length === 1) {
      const s = recentStrokes[0];
      const shape = recognizeShape(s);
      if (shape) {
        pendingCtx.clearRect(0, 0, pendingCanvas.width, pendingCanvas.height);
        drawCleanShape(artCtx, shape, s.color);
        recentStrokes.length = 0;
        strokesGen++;
        setRecogStatus('SHAPE · ' + shape.kind.toUpperCase());
        recognitionScheduled = false;
        return;
      }
    }

    // 2) Иначе — OCR.
    if (ocrInFlight) { recognitionScheduled = false; return; }
    ocrInFlight = true;
    setRecogStatus('OCR SCAN');
    const genAtStart = strokesGen;
    const snapshot = recentStrokes.slice();
    try {
      const r = await runOcrOnStrokes(snapshot);
      if (genAtStart !== strokesGen) {
        setRecogStatus('STAND BY');
        return;
      }
      if (r && r.text && r.conf >= OCR_MIN_CONF) {
        const color = recentStrokes[0].color;
        pendingCtx.clearRect(0, 0, pendingCanvas.width, pendingCanvas.height);
        drawCleanText(artCtx, r.text, r.bbox, color);
        recentStrokes.length = 0;
        strokesGen++;
        setRecogStatus(`OCR · «${r.text}» · ${Math.round(r.conf)}%`);
      } else {
        setRecogStatus(r ? `LOW CONF · ${Math.round(r.conf)}%` : 'OCR FAILED');
      }
    } catch (e) {
      setRecogStatus('OCR ERROR');
    } finally {
      ocrInFlight = false;
      recognitionScheduled = false;
    }
  }

  // Захват связной компоненты под точкой щепка.
  // BFS по альфа-каналу artCanvas: находит связное облако непрозрачных
  // пикселей вокруг (ax, ay), копирует их на плавающий холст и
  // стирает их из artCanvas. Радиус поиска seed-пикселя — 60 px.
  function tryGrabAt(ax, ay) {
    // Сначала коммитим pending, чтобы свежие штрихи тоже можно было взять.
    if (recentStrokes.length > 0) {
      for (const s of openStrokes.values()) bakeStrokeToPending(s);
      artCtx.drawImage(pendingCanvas, 0, 0);
      pendingCtx.clearRect(0, 0, pendingCanvas.width, pendingCanvas.height);
      liveCtx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
      recentStrokes.length = 0;
      openStrokes.clear();
      strokesGen++;
    }

    const w = artCanvas.width, h = artCanvas.height;
    if (w === 0 || h === 0) return null;
    let id;
    try { id = artCtx.getImageData(0, 0, w, h); }
    catch (e) { return null; }
    const data = id.data;

    const ALPHA_THR = 4;
    const SEARCH_RADIUS = 60;

    // Ищем самый близкий к (ax,ay) непрозрачный пиксель — seed BFS.
    const cx0 = Math.round(ax), cy0 = Math.round(ay);
    let seedX = -1, seedY = -1;
    for (let r = 0; r <= SEARCH_RADIUS && seedX < 0; r += 2) {
      if (r === 0) {
        if (cx0 >= 0 && cx0 < w && cy0 >= 0 && cy0 < h &&
          data[(cy0 * w + cx0) * 4 + 3] > ALPHA_THR) { seedX = cx0; seedY = cy0; }
        continue;
      }
      for (let dx = -r; dx <= r && seedX < 0; dx++) {
        for (const dy of [-r, r]) {
          const x = cx0 + dx, y = cy0 + dy;
          if (x < 0 || x >= w || y < 0 || y >= h) continue;
          if (data[(y * w + x) * 4 + 3] > ALPHA_THR) { seedX = x; seedY = y; break; }
        }
      }
      for (let dy = -r + 1; dy <= r - 1 && seedX < 0; dy++) {
        for (const dx of [-r, r]) {
          const x = cx0 + dx, y = cy0 + dy;
          if (x < 0 || x >= w || y < 0 || y >= h) continue;
          if (data[(y * w + x) * 4 + 3] > ALPHA_THR) { seedX = x; seedY = y; break; }
        }
      }
    }
    if (seedX < 0) return null;

    // BFS с 8-связностью по пикселям с alpha > ALPHA_THR.
    const visited = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let qHead = 0, qTail = 0;
    const seedIdx = seedY * w + seedX;
    visited[seedIdx] = 1;
    queue[qTail++] = seedIdx;
    let minX = seedX, maxX = seedX, minY = seedY, maxY = seedY;
    while (qHead < qTail) {
      const idx = queue[qHead++];
      const x = idx % w;
      const y = (idx - x) / w;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (visited[ni]) continue;
          if (data[ni * 4 + 3] > ALPHA_THR) {
            visited[ni] = 1;
            queue[qTail++] = ni;
          }
        }
      }
    }

    // Паддинг вокруг bbox.
    const pad = 4;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad);
    maxY = Math.min(h - 1, maxY + pad);
    const bw = maxX - minX + 1, bh = maxY - minY + 1;

    // Переносим пиксели компоненты на плавающий холст.
    const img = document.createElement('canvas');
    img.width = bw; img.height = bh;
    const imgCtx = img.getContext('2d');
    const out = imgCtx.createImageData(bw, bh);
    for (let y = 0; y < bh; y++) {
      const sy = minY + y;
      for (let x = 0; x < bw; x++) {
        const sx = minX + x;
        const sIdx = sy * w + sx;
        if (visited[sIdx]) {
          const s4 = sIdx * 4;
          const d4 = (y * bw + x) * 4;
          out.data[d4] = data[s4];
          out.data[d4 + 1] = data[s4 + 1];
          out.data[d4 + 2] = data[s4 + 2];
          out.data[d4 + 3] = data[s4 + 3];
        }
      }
    }
    imgCtx.putImageData(out, 0, 0);

    // Стираем компоненту из artCanvas — двойной приём:
    // 1) Напрямую зануляем альфу в visited-пикселях.
    // 2) Размытый destination-out по маске — убирает остаточный halo.
    const mask = document.createElement('canvas');
    mask.width = w; mask.height = h;
    const mctx = mask.getContext('2d');
    const md = mctx.createImageData(w, h);
    for (let i = 0; i < visited.length; i++) {
      if (visited[i]) {
        md.data[i * 4] = 255;
        md.data[i * 4 + 1] = 255;
        md.data[i * 4 + 2] = 255;
        md.data[i * 4 + 3] = 255;
      }
    }
    mctx.putImageData(md, 0, 0);

    for (let i = 0; i < visited.length; i++) {
      if (visited[i]) data[i * 4 + 3] = 0;
    }
    artCtx.putImageData(id, 0, 0);

    artCtx.save();
    artCtx.globalCompositeOperation = 'destination-out';
    artCtx.filter = 'blur(16px)';
    artCtx.drawImage(mask, 0, 0);
    artCtx.drawImage(mask, 0, 0);
    artCtx.drawImage(mask, 0, 0);
    artCtx.restore();

    return { img, bbox: { x: minX, y: minY, w: bw, h: bh } };
  }

  // Отпускаем захваченный фрагмент — композитим его обратно в artCanvas.
  function dropGrabbed() {
    if (!grabbed) return;
    artCtx.save();
    artCtx.translate(grabbed.pos.x, grabbed.pos.y);
    artCtx.rotate(grabbed.rot);
    artCtx.drawImage(grabbed.img, -grabbed.bbox.w / 2, -grabbed.bbox.h / 2);
    artCtx.restore();
    grabbed = null;
  }

  function maybeRecognize() {
    if (recentStrokes.length === 0) return;
    if (openStrokes.size > 0) return;
    if (grab) return;
    const idle = performance.now() - lastStrokeActivity;
    if (idle > COMMIT_IDLE_MS) {
      commitPending();
    } else if (idle > RECOGNIZE_IDLE_MS && !recognitionScheduled && !ocrInFlight) {
      recognitionScheduled = true;
      tryRecognize();
    }
  }

  function resetTransform() {
    tr.tx = 0; tr.ty = 0; tr.scale = 1; tr.rot = 0;
    grab = null;
  }

  // Перевод точки из координат view в координаты art (для рисования и ластика
  // в нужном месте на фактическом холсте, с учётом текущей трансформации).
  function viewToArt(vx, vy) {
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const cos = Math.cos(-tr.rot), sin = Math.sin(-tr.rot);
    const x0 = vx - cx - tr.tx;
    const y0 = vy - cy - tr.ty;
    const xr = x0 * cos - y0 * sin;
    const yr = x0 * sin + y0 * cos;
    return { x: xr / tr.scale + cx, y: yr / tr.scale + cy };
  }

  // Перерисовать видимый canvas: очистить и нарисовать artCanvas с трансформацией.
  function renderView(handInfos = [], showGrid = false) {
    renderLiveStrokes();
    viewCtx.clearRect(0, 0, canvas.width, canvas.height);
    const cx = canvas.width / 2, cy = canvas.height / 2;
    viewCtx.save();
    viewCtx.translate(cx + tr.tx, cy + tr.ty);
    viewCtx.rotate(tr.rot);
    viewCtx.scale(tr.scale, tr.scale);
    viewCtx.translate(-cx, -cy);
    viewCtx.drawImage(artCanvas, 0, 0);
    viewCtx.drawImage(pendingCanvas, 0, 0);
    viewCtx.drawImage(liveCanvas, 0, 0);
    if (grabbed) {
      viewCtx.save();
      viewCtx.translate(grabbed.pos.x, grabbed.pos.y);
      viewCtx.rotate(grabbed.rot);
      viewCtx.shadowColor = 'rgba(110,231,255,0.9)';
      viewCtx.shadowBlur = 8;
      viewCtx.drawImage(grabbed.img, -grabbed.bbox.w / 2, -grabbed.bbox.h / 2);
      viewCtx.restore();
    }
    viewCtx.restore();

    // Скомканные бумажные шарики (в view-пикселях, выше всего art-слоя).
    const _nowR = performance.now();
    for (const b of paperBalls) {
      if (b.morph) {
        const t = (_nowR - b.morph.startTime) / b.morph.duration;
        if (t >= 1) {
          b.morph = null;
          drawPaperBall(viewCtx, b.x, b.y, b.r, b.seed, b.alpha);
        } else {
          // ease-in-out cubic
          const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
          const scale = 1 - k * (1 - (b.r * 2) / Math.max(b.morph.bw, b.morph.bh));
          const rot = k * (Math.PI * 0.9);
          viewCtx.save();
          viewCtx.translate(b.x, b.y);
          viewCtx.rotate(rot);
          viewCtx.globalAlpha = (1 - k) * b.alpha;
          viewCtx.drawImage(
            b.morph.img,
            -b.morph.bw / 2 * scale,
            -b.morph.bh / 2 * scale,
            b.morph.bw * scale,
            b.morph.bh * scale
          );
          viewCtx.restore();
          const ballAlpha = Math.max(0, (k - 0.4) / 0.6) * b.alpha;
          if (ballAlpha > 0.01) {
            drawPaperBall(viewCtx, b.x, b.y, b.r, b.seed, ballAlpha);
          }
        }
      } else {
        drawPaperBall(viewCtx, b.x, b.y, b.r, b.seed, b.alpha);
      }
    }

    // Сетка-bbox вокруг рисунка (когда масштабируем двумя щепотками).
    if (showGrid) {
      const bbox = getArtBoundingBox();
      if (bbox) {
        const corners = [
          { x: bbox.x, y: bbox.y },
          { x: bbox.x + bbox.w, y: bbox.y },
          { x: bbox.x + bbox.w, y: bbox.y + bbox.h },
          { x: bbox.x, y: bbox.y + bbox.h },
        ].map(p => artToView(p.x, p.y));

        viewCtx.save();
        viewCtx.strokeStyle = 'rgba(110,231,255,0.85)';
        viewCtx.lineWidth = 1.5;
        viewCtx.setLineDash([8, 6]);
        viewCtx.beginPath();
        viewCtx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < 4; i++) viewCtx.lineTo(corners[i].x, corners[i].y);
        viewCtx.closePath();
        viewCtx.stroke();
        viewCtx.setLineDash([]);

        const handles = [
          corners[0], corners[1], corners[2], corners[3],
          midpoint(corners[0], corners[1]),
          midpoint(corners[1], corners[2]),
          midpoint(corners[2], corners[3]),
          midpoint(corners[3], corners[0]),
        ];
        handles.forEach(p => {
          viewCtx.fillStyle = '#0a0a0f';
          viewCtx.strokeStyle = '#6ee7ff';
          viewCtx.lineWidth = 2;
          viewCtx.beginPath();
          viewCtx.arc(p.x, p.y, 6, 0, Math.PI * 2);
          viewCtx.fill();
          viewCtx.stroke();
        });

        viewCtx.strokeStyle = 'rgba(110,231,255,0.25)';
        viewCtx.lineWidth = 1;
        viewCtx.setLineDash([4, 4]);
        for (let i = 1; i < 3; i++) {
          const t = i / 3;
          const top = lerpPt(corners[0], corners[1], t);
          const bot = lerpPt(corners[3], corners[2], t);
          const left = lerpPt(corners[0], corners[3], t);
          const right = lerpPt(corners[1], corners[2], t);
          viewCtx.beginPath();
          viewCtx.moveTo(top.x, top.y);
          viewCtx.lineTo(bot.x, bot.y);
          viewCtx.stroke();
          viewCtx.beginPath();
          viewCtx.moveTo(left.x, left.y);
          viewCtx.lineTo(right.x, right.y);
          viewCtx.stroke();
        }
        viewCtx.setLineDash([]);
        viewCtx.restore();
      }
    }

    // Скелет руки (трекинг-оверлей в стиле JARVIS).
    // Кости ВСЕХ рук собираются в один path и рисуются за 1 проход shadowBlur.
    if (handInfos.length > 0) {
      const w = canvas.width, ch = canvas.height;
      viewCtx.save();
      viewCtx.lineCap = 'round';
      viewCtx.lineJoin = 'round';
      viewCtx.beginPath();
      for (const h of handInfos) {
        const lm = h.rawLm || h.lm;
        for (let i = 0; i < HAND_BONES.length; i++) {
          const [a, b] = HAND_BONES[i];
          viewCtx.moveTo(lm[a].x * w, lm[a].y * ch);
          viewCtx.lineTo(lm[b].x * w, lm[b].y * ch);
        }
      }
      // 1) Толстая полупрозрачная подложка с glow — ОДИН shadowBlur-пасс.
      viewCtx.shadowColor = 'rgba(110,231,255,0.9)';
      viewCtx.shadowBlur = 8;
      viewCtx.strokeStyle = 'rgba(110,231,255,0.35)';
      viewCtx.lineWidth = 6;
      viewCtx.stroke();
      // 2) Тонкое яркое ядро по тому же path — без shadow.
      viewCtx.shadowBlur = 0;
      viewCtx.strokeStyle = 'rgba(220,250,255,0.95)';
      viewCtx.lineWidth = 1.6;
      viewCtx.stroke();
      // 3) Суставы — все кружки одним path, один fill.
      viewCtx.fillStyle = 'rgba(110,231,255,0.95)';
      viewCtx.beginPath();
      for (const h of handInfos) {
        const lm = h.rawLm || h.lm;
        for (let j = 0; j < 21; j++) {
          const x = lm[j].x * w, y = lm[j].y * ch;
          viewCtx.moveTo(x + 2.5, y);
          viewCtx.arc(x, y, 2.5, 0, Math.PI * 2);
        }
      }
      viewCtx.fill();
      // 4) Кончик указательного у каждой руки — маркер цвета пера с glow.
      viewCtx.shadowColor = currentColor;
      viewCtx.shadowBlur = 10;
      viewCtx.fillStyle = currentColor;
      viewCtx.beginPath();
      for (const h of handInfos) {
        const lm = h.rawLm || h.lm;
        const tip = lm[8];
        const tx = tip.x * w, ty = tip.y * ch;
        viewCtx.moveTo(tx + 6, ty);
        viewCtx.arc(tx, ty, 6, 0, Math.PI * 2);
      }
      viewCtx.fill();
      // Белая точка по центру кончика — без shadow.
      viewCtx.shadowBlur = 0;
      viewCtx.fillStyle = 'rgba(255,255,255,0.95)';
      viewCtx.beginPath();
      for (const h of handInfos) {
        const lm = h.rawLm || h.lm;
        const tip = lm[8];
        const tx = tip.x * w, ty = tip.y * ch;
        viewCtx.moveTo(tx + 2, ty);
        viewCtx.arc(tx, ty, 2, 0, Math.PI * 2);
      }
      viewCtx.fill();
      viewCtx.restore();
    }
  }

  // Утилиты для сетки
  function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function lerpPt(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

  // Перевод точки из art в view (для оверлеев)
  function artToView(ax, ay) {
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const x0 = (ax - cx) * tr.scale;
    const y0 = (ay - cy) * tr.scale;
    const cos = Math.cos(tr.rot), sin = Math.sin(tr.rot);
    return {
      x: x0 * cos - y0 * sin + cx + tr.tx,
      y: x0 * sin + y0 * cos + cy + tr.ty,
    };
  }

  // Bounding box непрозрачных пикселей art-холста.
  // Считается на лету, кешируется на 200 мс чтобы не нагружать CPU.
  let bboxCache = { stamp: 0, value: null };
  function getArtBoundingBox() {
    const now = performance.now();
    if (now - bboxCache.stamp < 200) return bboxCache.value;
    bboxCache.stamp = now;

    const w = artCanvas.width, h = artCanvas.height;
    if (w === 0 || h === 0) return (bboxCache.value = null);
    let data;
    try { data = artCtx.getImageData(0, 0, w, h).data; }
    catch (e) { return (bboxCache.value = null); }

    const step = 4;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const a = data[(y * w + x) * 4 + 3];
        if (a > 16) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return (bboxCache.value = null);
    const pad = 20;
    bboxCache.value = {
      x: Math.max(0, minX - pad),
      y: Math.max(0, minY - pad),
      w: Math.min(w, maxX + pad) - Math.max(0, minX - pad),
      h: Math.min(h, maxY + pad) - Math.max(0, minY - pad),
    };
    return bboxCache.value;
  }

  // FPS
  let frames = 0, lastFpsTime = performance.now();
  function tickFps() {
    frames++;
    const now = performance.now();
    if (now - lastFpsTime > 1000) {
      fpsEl.textContent = Math.round((frames * 1000) / (now - lastFpsTime));
      frames = 0;
      lastFpsTime = now;
    }
  }

  // Перерисовка всех активных штрихов в liveCanvas — вызывается каждый кадр.
  function renderLiveStrokes() {
    liveCtx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
    if (openStrokes.size === 0) return;
    for (const stroke of openStrokes.values()) {
      if (stroke.points && stroke.points.length >= 2) {
        drawCatmullStroke(liveCtx, stroke.points, stroke.color);
      }
    }
  }

  // Запекаем закрытый штрих в pendingCanvas (там он живёт до OCR/идл-коммита).
  function bakeStrokeToPending(stroke) {
    if (!stroke || !stroke.points || stroke.points.length < 2) return;
    drawCatmullStroke(pendingCtx, stroke.points, stroke.color);
  }

  // Скрыть/показать круговой индикатор удержания и обновить прогресс.
  function setHoldRing(visible, x, y, progress) {
    if (!visible) {
      holdRing.style.display = 'none';
      return;
    }
    const rect = wrap.getBoundingClientRect();
    holdRing.style.display = 'block';
    holdRing.style.left = (rect.left + x) + 'px';
    holdRing.style.top = (rect.top + y - 80) + 'px';
    const total = 327; // 2π·r где r=52
    holdProgress.setAttribute('stroke-dashoffset', total * (1 - progress));
  }

  // Параметры One-Euro фильтра подобраны под ландмарки в нормализованных
  // координатах (0..1).
  const OE_MINCUTOFF = 4.5;
  const OE_BETA = 0.85;
  const OE_DCUTOFF = 1.0;
  const oneEuroState = new Map();
  function getHandFilters(handIdx) {
    let arr = oneEuroState.get(handIdx);
    if (!arr) {
      arr = new Array(42);
      for (let i = 0; i < 42; i++) {
        arr[i] = makeOneEuro(OE_MINCUTOFF, OE_BETA, OE_DCUTOFF);
      }
      oneEuroState.set(handIdx, arr);
    }
    return arr;
  }
  function resetHandFilters() {
    oneEuroState.clear();
  }

  function onResults(results) {
    loading.classList.add('hidden');
    tickFps();

    const hands = results.multiHandLandmarks || [];

    // СЫРЫЕ ландмарки — для рендера скелета (визуально «прилипают» к руке).
    // ОТФИЛЬТРОВАННЫЕ — для логики жестов (стабильнее распознаются).
    const rawHands = hands.map(lm => lm.map(p => ({ x: p.x, y: p.y, z: p.z })));
    if (hands.length > 0) {
      const tNow = performance.now();
      for (let hi = 0; hi < hands.length; hi++) {
        const lm = hands[hi];
        const filters = getHandFilters(hi);
        for (let j = 0; j < lm.length; j++) {
          lm[j].x = filters[j * 2](lm[j].x, tNow);
          lm[j].y = filters[j * 2 + 1](lm[j].y, tNow);
        }
      }
    }

    if (hands.length === 0) {
      gestureEl.textContent = 'NO SIGNAL';
      lastPoints.clear();
      holdStart = 0;
      holdJustFired = false;
      setHoldRing(false);
      pointingDebounce.clear();
      pinchDebounce.clear();
      crumpleDebounce.clear();
      resetHandFilters();
      grab = null;
      crumpling = null;
      if (openStrokes.size > 0) {
        for (const s of openStrokes.values()) bakeStrokeToPending(s);
        openStrokes.clear();
        lastStrokeActivity = performance.now();
      }
      dropGrabbed();
      maybeRecognize();
      renderView([], false);
      return;
    }

    const activeKeys = new Set();
    let anyDraw = false;
    let anyFist = false;
    let openPalmHand = null;

    // Сначала классифицируем КАЖДУЮ руку, потом решаем что делать.
    const handInfos = hands.map((lm, handIdx) => {
      const { up, tipIdx } = getFingersUp(lm);
      const fist = isFist(lm);
      const palm = isOpenPalm(lm);
      // СТРОГИЙ "указательный" жест: указательный выпрямлен, остальные
      // три опущены, большой любой; дополнительно — указательный заметно
      // ДАЛЬШЕ от запястья, чем остальные три кончика.
      let pointing = up[1] && !up[2] && !up[3] && !up[4];
      if (pointing) {
        const wrist = lm[0];
        const d = (p) => Math.hypot(p.x - wrist.x, p.y - wrist.y);
        const dIndex = d(lm[8]);
        const dMid = d(lm[12]);
        const dRing = d(lm[16]);
        const dPinky = d(lm[20]);
        if (dIndex < dMid * 1.25) pointing = false;
        if (dIndex < dRing * 1.25) pointing = false;
        if (dIndex < dPinky * 1.25) pointing = false;
      }
      // 5-пальцевый пинч имеет приоритет над 3-пинчем и кулаком — иначе
      // жест "скомкать" будет параллельно включать захват фрагмента или ластик.
      const pinch5 = isFiveFingerPinch(lm);
      const pinch3 = !pinch5 && isThreeFingerPinch(lm);
      const fistGated = !pinch5 && fist;
      const rawLm = rawHands[handIdx] || lm;
      const spreadPalm = palm && isSpreadPalm(lm);
      const handednessRaw = (results.multiHandedness || [])[handIdx] || {};
      const handedness = handednessRaw.categoryName || handednessRaw.label || '';
      // 2D-нормаль ладони через знак векторного произведения (lm5-lm0)×(lm17-lm0).
      const v1x = lm[5].x - lm[0].x, v1y = lm[5].y - lm[0].y;
      const v2x = lm[17].x - lm[0].x, v2y = lm[17].y - lm[0].y;
      const crossZ = v1x * v2y - v1y * v2x;
      const palmFacing = (handedness === 'Right') ? crossZ > 0
        : (handedness === 'Left') ? crossZ < 0
          : true;
      return { lm, rawLm, handIdx, up, tipIdx, fist: fistGated, palm, spreadPalm, palmFacing, handedness, pointing, pinch3, pinch5 };
    });

    handInfos.filter(h => h.palm).forEach(h => { if (!openPalmHand) openPalmHand = h.lm; });

    // Детектор жеста 🤘 rock → смена цвета (edge-trigger со стабилизацией).
    handInfos.forEach(h => {
      let st = peaceState.get(h.handIdx);
      if (!st) { st = { stable: 0, fired: false }; peaceState.set(h.handIdx, st); }
      const busy = h.pinch3 || h.pinch5 || h.fist || h.palm || h.pointing;
      const isPeace = !busy && h.up[1] && !h.up[2] && !h.up[3] && h.up[4];
      if (isPeace) {
        st.stable += 1;
        if (st.stable >= PEACE_STABLE_FRAMES && !st.fired) {
          st.fired = true;
          nextColor();
          snapFlashUntil = performance.now() + 800;
        }
      } else {
        st.stable = 0;
        st.fired = false;
      }
    });

    // Дебаунс по каждой руке для жеста-щепотки.
    handInfos.forEach(h => {
      const dk = 'h' + h.handIdx;
      if (h.pinch3) pinchDebounce.set(dk, (pinchDebounce.get(dk) || 0) + 1);
      else pinchDebounce.set(dk, 0);
    });
    const stablePinchHands = handInfos.filter(
      h => (pinchDebounce.get('h' + h.handIdx) || 0) >= PINCH_STABLE_FRAMES
    );

    function pinchCenterView(h) {
      const x = (h.lm[4].x + h.lm[8].x + h.lm[12].x) / 3;
      const y = (h.lm[4].y + h.lm[8].y + h.lm[12].y) / 3;
      return { x: x * canvas.width, y: y * canvas.height };
    }
    function pinch5CenterView(h) {
      const lm = h.lm;
      const x = (lm[4].x + lm[8].x + lm[12].x + lm[16].x + lm[20].x) / 5;
      const y = (lm[4].y + lm[8].y + lm[12].y + lm[16].y + lm[20].y) / 5;
      return { x: x * canvas.width, y: y * canvas.height };
    }

    // ===== ПРИОРИТЕТ 0: комкающий жест (5-пальцевый пинч) =====
    handInfos.forEach(h => {
      const dk = 'h' + h.handIdx;
      if (h.pinch5) crumpleDebounce.set(dk, (crumpleDebounce.get(dk) || 0) + 1);
      else crumpleDebounce.set(dk, 0);
    });
    const stableCrumpleHands = handInfos.filter(
      h => (crumpleDebounce.get('h' + h.handIdx) || 0) >= CRUMPLE_STABLE_FRAMES
    );

    if (crumpling) {
      const same = stableCrumpleHands.find(h => h.handIdx === crumpling.handIdx);
      if (same) {
        const pc = pinch5CenterView(same);
        crumpling.ball.x = pc.x;
        crumpling.ball.y = pc.y;
        const palmSize = Math.hypot(same.lm[0].x - same.lm[9].x,
          same.lm[0].y - same.lm[9].y);
        const t = performance.now();
        crumpling.history.push({ t, x: pc.x, y: pc.y, s: palmSize });
        while (crumpling.history.length > 0 && t - crumpling.history[0].t > 300) {
          crumpling.history.shift();
        }
        gestureEl.textContent = '🗑 CRUMPLE';
      } else {
        // Отпустили — считаем скорость по истории. Ищем ПИК скорости в окне.
        const hist = crumpling.history;
        if (hist.length >= 2) {
          let bestVx = 0, bestVy = 0, bestSpeed = 0, bestDSize = 0;
          for (let i = 0; i < hist.length; i++) {
            for (let j = i + 1; j < hist.length; j++) {
              const dt = (hist[j].t - hist[i].t) / 1000;
              if (dt < 0.04 || dt > 0.12) continue;
              const vx = (hist[j].x - hist[i].x) / dt;
              const vy = (hist[j].y - hist[i].y) / dt;
              const ds = (hist[j].s - hist[i].s) / dt;
              const sp = Math.hypot(vx, vy);
              if (sp > bestSpeed) { bestSpeed = sp; bestVx = vx; bestVy = vy; }
              if (ds > bestDSize) bestDSize = ds;
            }
          }
          if (bestDSize > 0.30) {
            // Forward-замах: рука дёрнулась вперёд → комок улетает в экран.
            crumpling.ball.vx = bestVx * 0.25;
            crumpling.ball.vy = bestVy * 0.25;
            crumpling.ball.forward = true;
            crumpling.ball.shrinkRate = Math.min(10, 3 + bestDSize * 5);
            crumpling.ball.dying = performance.now();
          } else if (bestSpeed > 280) {
            crumpling.ball.vx = bestVx;
            crumpling.ball.vy = bestVy;
            crumpling.ball.dying = performance.now();
          }
        }
        crumpling = null;
      }
    } else if (stableCrumpleHands.length > 0) {
      const ph = stableCrumpleHands[0];
      const pcView = pinch5CenterView(ph);
      // Проверяем — может рука над уже существующим шариком (поднять).
      let picked = null;
      for (let i = paperBalls.length - 1; i >= 0; i--) {
        const b = paperBalls[i];
        if (b.dying) continue;
        if (Math.hypot(pcView.x - b.x, pcView.y - b.y) < b.r + 25) {
          picked = b;
          break;
        }
      }
      if (picked) {
        crumpling = {
          handIdx: ph.handIdx,
          ball: picked,
          history: [{ t: performance.now(), x: picked.x, y: picked.y }],
        };
        gestureEl.textContent = '🗑 PICK UP';
      } else {
        // Скомкать рисунок под рукой.
        const va = viewToArt(pcView.x, pcView.y);
        const region = tryGrabAt(va.x, va.y);
        if (region) {
          const r = Math.max(28, Math.min(70,
            Math.max(region.bbox.w, region.bbox.h) / 4));
          const ball = {
            id: nextBallId++,
            x: pcView.x, y: pcView.y, r,
            seed: Math.floor(Math.random() * 1e9),
            vx: 0, vy: 0, alpha: 1, dying: 0,
            morph: {
              img: region.img,
              bw: region.bbox.w,
              bh: region.bbox.h,
              startTime: performance.now(),
              duration: 420,
            },
          };
          paperBalls.push(ball);
          crumpling = {
            handIdx: ph.handIdx,
            ball,
            history: [{ t: performance.now(), x: pcView.x, y: pcView.y }],
          };
          gestureEl.textContent = '🗑 CRUMPLED';
          if (grabbed) grabbed = null;
        }
      }
    }

    // Физика летящих шариков.
    const _now = performance.now();
    for (let i = paperBalls.length - 1; i >= 0; i--) {
      const b = paperBalls[i];
      if (b.dying) {
        const elapsed = _now - b.dying;
        const dt = 1 / 60;
        if (b.forward) {
          // Forward-бросок: без гравитации, быстрое уменьшение и затухание.
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          b.r *= Math.max(0.5, 1 - b.shrinkRate * dt);
          b.alpha = Math.max(0, 1 - elapsed / 500);
          if (b.alpha <= 0 || b.r < 3) {
            purgePaperBall(b.seed);
            paperBalls.splice(i, 1);
          }
        } else {
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          b.vy += 1200 * dt;
          b.vx *= 0.99;
          b.alpha = Math.max(0, 1 - elapsed / 700);
          if (b.alpha <= 0 ||
            b.x < -120 || b.x > canvas.width + 120 ||
            b.y > canvas.height + 200) {
            purgePaperBall(b.seed);
            paperBalls.splice(i, 1);
          }
        }
      }
    }

    // Пока идёт комкание — блокируем hold-palm-clear.
    if (crumpling) openPalmHand = null;

    // ===== ПРИОРИТЕТ 1: две щепотки — zoom (трансляция + масштаб) =====
    if (stablePinchHands.length >= 2) {
      if (grabbed) dropGrabbed();
      const a = pinchCenterView(stablePinchHands[0]);
      const b = pinchCenterView(stablePinchHands[1]);
      if (!grab) {
        grab = {
          trStart: { ...tr },
          midStart: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          distStart: Math.hypot(b.x - a.x, b.y - a.y),
        };
      } else {
        const midNow = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const distNow = Math.hypot(b.x - a.x, b.y - a.y);
        const targetTx = grab.trStart.tx + (midNow.x - grab.midStart.x);
        const targetTy = grab.trStart.ty + (midNow.y - grab.midStart.y);
        let targetScale = tr.scale;
        if (grab.distStart > 5) {
          const k = distNow / grab.distStart;
          targetScale = Math.max(0.1, Math.min(8, grab.trStart.scale * k));
        }
        // EMA-сглаживание: гасит дрожь ландмарков, убирает рывки масштаба.
        const A_TR = 0.45;
        const A_SC = 0.30;
        tr.tx += (targetTx - tr.tx) * A_TR;
        tr.ty += (targetTy - tr.ty) * A_TR;
        tr.scale += (targetScale - tr.scale) * A_SC;
      }
      gestureEl.textContent = `⛬ ZOOM ×${(tr.scale).toFixed(2)}`;
      pointingDebounce.clear();
    } else {
      grab = null;

      // ===== ПРИОРИТЕТ 2: Одна щепотка — захват фрагмента =====
      if (grabbed) {
        const same = stablePinchHands.find(h => h.handIdx === grabbed.handIdx);
        if (same) {
          const pc = {
            x: (same.lm[4].x + same.lm[8].x + same.lm[12].x) / 3,
            y: (same.lm[4].y + same.lm[8].y + same.lm[12].y) / 3,
          };
          const va = viewToArt(pc.x * canvas.width, pc.y * canvas.height);
          const targetX = grabbed.startPos.x + (va.x - grabbed.startPinch.x);
          const targetY = grabbed.startPos.y + (va.y - grabbed.startPinch.y);
          const SMOOTH_A = 0.45;
          grabbed.pos.x += (targetX - grabbed.pos.x) * SMOOTH_A;
          grabbed.pos.y += (targetY - grabbed.pos.y) * SMOOTH_A;

          // Поворот делает ВТОРАЯ рука. Инициируем по открытой ладони,
          // дальше sticky — пока не пропадёт или не станет щепкой.
          let rotHand = null;
          if (grabbed.rotHandIdx !== null) {
            rotHand = handInfos.find(
              h => h.handIdx === grabbed.rotHandIdx && !h.pinch3
            );
          }
          if (!rotHand) {
            // Trigger rotation with any open hand (not a fist, not a pinch).
            // h.palm was too strict — impossible to hold perfect open palm while other
            // hand is pinching. Any spread/relaxed hand now activates rotation.
            const cand = handInfos.find(
              h => h.handIdx !== grabbed.handIdx && !h.pinch3 && !h.fist
            );
            if (cand) {
              rotHand = cand;
              grabbed.rotHandIdx = cand.handIdx;
              grabbed.rotHandStartAng = palmRotation(cand.lm);
              grabbed.startRot = grabbed.rot;
            }
          }
          if (rotHand) {
            const ang = palmRotation(rotHand.lm);
            grabbed.rot = grabbed.startRot - (ang - grabbed.rotHandStartAng);
            gestureEl.textContent = `⌖ ROTATE ${Math.round(-grabbed.rot * 180 / Math.PI)}°`;
          } else {
            grabbed.rotHandIdx = null;
            gestureEl.textContent = '⌖ TRANSLATE';
          }
        } else {
          dropGrabbed();
        }
      } else if (stablePinchHands.length > 0) {
        const ph = stablePinchHands[0];
        const pc = {
          x: (ph.lm[4].x + ph.lm[8].x + ph.lm[12].x) / 3,
          y: (ph.lm[4].y + ph.lm[8].y + ph.lm[12].y) / 3,
        };
        const va = viewToArt(pc.x * canvas.width, pc.y * canvas.height);
        const region = tryGrabAt(va.x, va.y);
        if (region) {
          const cx = region.bbox.x + region.bbox.w / 2;
          const cy = region.bbox.y + region.bbox.h / 2;
          grabbed = {
            img: region.img,
            bbox: region.bbox,
            handIdx: ph.handIdx,
            startPinch: { x: va.x, y: va.y },
            startPos: { x: cx, y: cy },
            startRot: 0,
            pos: { x: cx, y: cy },
            rot: 0,
            rotHandIdx: null,
            rotHandStartAng: 0,
          };
          gestureEl.textContent = '⌖ LOCK';
        }
      }

      if (grabbed) openPalmHand = null;

      const eraseAllowed = recentStrokes.length > 0 || getArtBoundingBox() !== null;

      // ===== ПРИОРИТЕТ 3..5: обрабатываем каждую руку отдельно =====
      handInfos.forEach(h => {
        if (h.pinch3) {
          pointingDebounce.set('h' + h.handIdx, 0);
          return;
        }
        // Skip hands that are actively involved in a grab gesture:
        // the grabbing hand itself and the rotation hand must not
        // accidentally trigger erase or draw at the same time.
        if (grabbed && (
          h.handIdx === grabbed.handIdx ||
          (grabbed.rotHandIdx !== null && h.handIdx === grabbed.rotHandIdx)
        )) return;
        if (!h.pointing) {
          pointingDebounce.set('h' + h.handIdx, 0);
        }
        // Ластик: открытая ладонь, повёрнутая ВНУТРЕННЕЙ стороной к камере.
        if (h.palm && h.palmFacing && eraseAllowed) {
          anyFist = true;
          const palmCenter = h.lm[9];
          const vx = palmCenter.x * canvas.width;
          const vy = palmCenter.y * canvas.height;
          const a = viewToArt(vx, vy);
          const er = eraserRadius / tr.scale;
          for (const cxx of [artCtx, pendingCtx]) {
            cxx.save();
            cxx.globalCompositeOperation = 'destination-out';
            cxx.beginPath();
            cxx.arc(a.x, a.y, er, 0, Math.PI * 2);
            cxx.fill();
            cxx.restore();
          }
          // Штрихи в pending, которых коснулся ластик, выкидываем из буфера.
          let dropped = 0;
          for (let i = recentStrokes.length - 1; i >= 0; i--) {
            const s = recentStrokes[i];
            let hit = false;
            for (const p of s.points) {
              if (Math.hypot(p.x - a.x, p.y - a.y) < er) { hit = true; break; }
            }
            if (hit) {
              for (const [k, ss] of openStrokes) if (ss === s) openStrokes.delete(k);
              recentStrokes.splice(i, 1);
              dropped++;
            }
          }
          if (dropped > 0) strokesGen++;
          lastStrokeActivity = performance.now();
          recognitionScheduled = false;
        } else if (h.palm) {
          // обработка прогресс-таймера ниже
        } else if (h.pointing) {
          const dbKey = 'h' + h.handIdx;
          const cnt = (pointingDebounce.get(dbKey) || 0) + 1;
          pointingDebounce.set(dbKey, cnt);

          if (cnt < POINTING_STABLE_FRAMES) {
            return;
          }

          anyDraw = true;
          const tip = h.lm[h.tipIdx[1]];
          const vx = tip.x * canvas.width;
          const vy = tip.y * canvas.height;
          const a = viewToArt(vx, vy);
          const rawX = a.x, rawY = a.y;

          const key = h.handIdx + '_index';
          activeKeys.add(key);

          let stroke = openStrokes.get(key);
          if (!stroke) {
            stroke = { color: currentColor, points: [], lastTime: performance.now() };
            openStrokes.set(key, stroke);
            recentStrokes.push(stroke);
            strokesGen++;
            recognitionScheduled = false;
          }

          // Экспоненциальное сглаживание (low-pass). Лёгкое — Catmull-Rom сам
          // сглаживает геометрию, тяжёлое EMA только добавляет лаг.
          const SMOOTH = 0.45;
          const prev = lastPoints.get(key);
          let x, y;
          if (prev) {
            x = prev.x * SMOOTH + rawX * (1 - SMOOTH);
            y = prev.y * SMOOTH + rawY * (1 - SMOOTH);
          } else {
            x = rawX; y = rawY;
          }

          // Отбрасываем точки, слишком близкие к предыдущей (<1.5px) —
          // на них Catmull-Rom производит «петельки» из-за деления на 0.
          const MIN_PT_DIST = 1.5;
          const skip = prev && Math.hypot(x - prev.x, y - prev.y) < MIN_PT_DIST;
          if (!skip) {
            stroke.points.push({ x, y });
            lastPoints.set(key, { x, y });
          }
          stroke.lastTime = performance.now();
          lastStrokeActivity = stroke.lastTime;
        }
      });
    }

    // Удаляем lastPoints только для тех ключей, у которых уже нет открытого
    // штриха. Иначе при кратком пропадании детекции lastPoints удалится,
    // и при возврате жеста будет скачок (smoothing начнётся с нуля).
    for (const key of [...lastPoints.keys()]) {
      if (!activeKeys.has(key) && !openStrokes.has(key)) lastPoints.delete(key);
    }
    // Закрываем штрихи, чьи руки больше не в режиме рисования.
    // Грейс-период: одиночные пропавшие кадры детекции НЕ закрывают штрих.
    const nowTs = performance.now();
    for (const k of [...openStrokes.keys()]) {
      if (!activeKeys.has(k)) {
        const closing = openStrokes.get(k);
        if (nowTs - closing.lastTime < STROKE_CONTINUITY_MS) continue;
        bakeStrokeToPending(closing);
        openStrokes.delete(k);
        lastStrokeActivity = nowTs;
      }
    }

    // Обработка жеста полной очистки: удержание раскрытой ладони.
    const now = performance.now();
    if (openPalmHand) {
      if (holdStart === 0 && !holdJustFired) {
        holdStart = now;
      }
      const elapsed = now - holdStart;
      const progress = Math.min(elapsed / HOLD_MS, 1);

      const palm = openPalmHand[9];
      // canvas зеркалится через CSS, поэтому DOM-координаты нужно отразить по x.
      const px = (1 - palm.x) * canvas.width;
      const py = palm.y * canvas.height;

      if (!holdJustFired) {
        setHoldRing(true, px, py, progress);
        if (progress >= 1) {
          wipeAll();
          holdJustFired = true;
          setHoldRing(false);
        }
      }

      if (anyDraw) gestureEl.textContent = '☝ INK';
      else if (anyFist) gestureEl.textContent = '🖐 ERASE';
      else if (holdJustFired) gestureEl.textContent = '🖐 WIPED';
      else gestureEl.textContent = `🖐 HOLD · ${Math.round(progress * 100)}%`;
    } else {
      holdStart = 0;
      holdJustFired = false;
      setHoldRing(false);

      if (!grab && !grabbed && !crumpling) {
        if (anyDraw) gestureEl.textContent = '☝ INK';
        else if (anyFist) gestureEl.textContent = '🖐 ERASE';
        else gestureEl.textContent = '— IDLE';
      }
    }

    maybeRecognize();

    // Краткий флэш-индикатор смены цвета через rock-жест.
    if (performance.now() < snapFlashUntil) {
      gestureEl.textContent = '🤘 COLOR · ' + currentColor.toUpperCase();
    }

    renderView(handInfos, !!grab);
  }

  // ----- MediaPipe Tasks Vision (HandLandmarker) -----
  let handLandmarker;
  try {
    handLandmarker = await initHandLandmarker();
  } catch (err) {
    loading.innerHTML = `
    <div style="max-width:420px;">
      <div style="font-size:20px; margin-bottom:12px;">⚠️ Не удалось загрузить модель рук</div>
      <div style="font-size:14px; color:rgba(255,255,255,0.7);">${err.message || err}</div>
    </div>`;
    return;
  }

  // Поднимаем камеру через getUserMedia.
  let currentFacing = 'user';

  async function launchCamera(facingMode = 'user') {
    currentFacing = facingMode;
    await startCamera(video, CAM_W, CAM_H, facingMode);
    // При смене камеры сбрасываем фильтры — они помнят старые координаты
    // и при переключении дают секундный "дрифт" к новой позиции.
    oneEuroState.clear();
    // Заднюю камеру НЕ зеркалим — она уже показывает правильно.
    // Переднюю — зеркалим (transform: scaleX(-1)) как обычно.
    const mirror = facingMode === 'user' ? 'scaleX(-1)' : 'scaleX(1)';
    video.style.transform  = mirror;
    canvas.style.transform = mirror;
  }

  try {
    await launchCamera('user');
  } catch (err) {
    loading.innerHTML = `
    <div style="max-width:400px;">
      <div style="font-size:20px; margin-bottom:12px;">⚠️ Не удалось запустить камеру</div>
      <div style="font-size:14px; color:rgba(255,255,255,0.7);">${err.message || err}</div>
      <div style="font-size:13px; color:rgba(255,255,255,0.5); margin-top:14px;">
        Проверь, что страница открыта по https:// или с localhost.
      </div>
    </div>`;
    return;
  }

  // Кнопка переключения камеры (видна только на мобильных через CSS).
  document.getElementById('camFlip').addEventListener('click', async () => {
    const next = currentFacing === 'user' ? 'environment' : 'user';
    try {
      await launchCamera(next);
    } catch (e) {
      // Некоторые телефоны не имеют фронтальной/задней — молча игнорируем.
      console.warn('[cam] switch failed:', e.message);
    }
  });

  // Главный цикл: на каждый новый кадр видео вызываем detectForVideo,
  // и шимуем результат под старый формат, который ждёт onResults.
  let lastVideoTs = -1;
  function detectLoop() {
    if (video.readyState >= 2 && video.currentTime !== lastVideoTs) {
      lastVideoTs = video.currentTime;
      try {
        const r = handLandmarker.detectForVideo(video, performance.now());
        onResults(shimResults(r));
      } catch (e) {
        console.error('[hand] detectForVideo error:', e);
      }
    }
    requestAnimationFrame(detectLoop);
  }
  requestAnimationFrame(detectLoop);
})();
