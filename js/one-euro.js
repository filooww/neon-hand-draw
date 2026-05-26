// One-Euro filter (Casiez et al., 2012).
// Адаптивный low-pass: при медленном движении сильно гасит дрожь,
// при быстром — почти не фильтрует (нет ощущения лага).

export function makeOneEuro(mincutoff, beta, dcutoff) {
  let xPrev = null, dxPrev = null, tPrev = 0;
  const alphaFn = (cutoff, dt) => {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  };
  return function (v, tNow) {
    const dt = tPrev > 0 ? Math.max(0.001, (tNow - tPrev) / 1000) : 1 / 30;
    tPrev = tNow;
    const dx = xPrev === null ? 0 : (v - xPrev) / dt;
    const aD = alphaFn(dcutoff, dt);
    const edx = dxPrev === null ? dx : aD * dx + (1 - aD) * dxPrev;
    dxPrev = edx;
    const cutoff = mincutoff + beta * Math.abs(edx);
    const aX = alphaFn(cutoff, dt);
    const ex = xPrev === null ? v : aX * v + (1 - aX) * xPrev;
    xPrev = ex;
    return ex;
  };
}
