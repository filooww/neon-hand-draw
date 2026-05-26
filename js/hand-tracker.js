// Загрузка MediaPipe Tasks Vision (HandLandmarker) и обёртка над detectForVideo.
// API: initHandLandmarker() → handLandmarker; startCamera(video, w, h, facingMode) → MediaStream;
// shimResults(rawResults) приводит ответ нового API к формату старого
// MediaPipe Hands (multiHandLandmarks / multiHandedness / ...), которого
// ждёт основной код.

const TASKS_VERSION = '0.10.14';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Определяем мобильное устройство один раз при загрузке модуля.
// Используем touchPoints как основной признак — надёжнее чем user-agent.
export const IS_MOBILE =
  navigator.maxTouchPoints > 0 &&
  window.matchMedia('(max-width: 768px)').matches;

// Рекомендуемое разрешение камеры: на мобильных ниже для экономии CPU/GPU.
export const CAM_W = IS_MOBILE ? 640 : 960;
export const CAM_H = IS_MOBILE ? 360 : 540;

export async function initHandLandmarker() {
  const { HandLandmarker, FilesetResolver } = await import(
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/vision_bundle.mjs`
  );
  const fileset = await FilesetResolver.forVisionTasks(
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/wasm`
  );
  const baseOptions = {
    runningMode: 'VIDEO',
    numHands: 2,
    // На мобильных немного снижаем пороги: при плохом освещении и дрожащей
    // руке высокие пороги дают провалы детекции и рваные штрихи.
    minHandDetectionConfidence: IS_MOBILE ? 0.50 : 0.55,
    minHandPresenceConfidence:  IS_MOBILE ? 0.45 : 0.50,
    minTrackingConfidence:      IS_MOBILE ? 0.35 : 0.40,
  };
  // Сначала пробуем GPU-делегат (WebGL); если не поддерживается — fallback на CPU.
  try {
    return await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      ...baseOptions,
    });
  } catch (gpuErr) {
    console.warn('[hand] GPU делегат недоступен, перехожу на CPU:', gpuErr);
    return await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      ...baseOptions,
    });
  }
}

/**
 * Запускает камеру.
 * @param {HTMLVideoElement} video
 * @param {number}  width
 * @param {number}  height
 * @param {'user'|'environment'} facingMode
 * @returns {Promise<MediaStream>}
 */
export async function startCamera(video, width = CAM_W, height = CAM_H, facingMode = 'user') {
  // Останавливаем предыдущий стрим если был (переключение камер).
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width:      { ideal: width  },
      height:     { ideal: height },
      facingMode: { ideal: facingMode },
    },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

// Приводит ответ нового HandLandmarker к старой схеме MediaPipe Hands.
export function shimResults(r) {
  return {
    multiHandLandmarks:      r.landmarks     || [],
    multiHandWorldLandmarks: r.worldLandmarks || [],
    multiHandedness:         (r.handednesses || []).map(arr => arr[0] || {}),
  };
}
