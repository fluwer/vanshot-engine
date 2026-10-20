// «Живой» туман войны у игроков: мягкие края и дымка, колышущаяся вдоль границы тумана.
// ГМ этого слоя не видит — ему нужны точные квадраты клеток со штриховкой (map.js, ветка role === 'gm').
//
// Что рисуем (window.fogFx.draw вызывает map.js на месте прежней заливки тумана, то есть над картинками,
// сеткой и спецэффектами и под рисунками, токенами и линейкой):
//   • глубина тумана — клетки, до границы которых ≥ ~3 клеток, одной векторной заливкой цвета --bg (как раньше);
//   • полоса вокруг границы (~3 клетки в обе стороны) — CPU-«шейдер» в уменьшенном буфере (≤ ~90 тыс. пикселей),
//     который растягивается на холст со сглаживанием: мягкость даёт сам масштаб, фильтры холста не нужны.
//     Пиксель полосы = тело тумана (билинейная выборка сетки клеток БЕЗ смещения: скрытое проглядывает не глубже
//     ~1/3 клетки, углы скругляются) + холодная дымка (выборка размытой сетки по координатам, смещённым
//     медленным шумом, — волны вдоль границы; вес максимален на границе и гаснет в обе стороны).
// Считаются только пиксели полосы, буферы переиспользуются. Работа остановлена, когда делать нечего (map.js
// не просит кадров). Если машина не тянет, анимация упрощается: 24 → 12 кадров/с → статичные мягкие края.
//
// Личный выключатель — localStorage['fog:off'] (выключено = статичные мягкие края, не квадраты); при
// prefers-reduced-motion тоже статично. window.fogFx: available, draw, noteFrame, targetFps, animationOn,
// setEnabled, get, force, debug; событие document 'fogfx:change' (detail = get()) для Vue и для map.js.
(function () {
  const STORAGE_KEY = 'fog:off';
  const TILE = 256;            // сторона плитки шума (текселей)
  const TEX_PER_CELL = 16;     // текселей шума на клетку: период плитки = 16 клеток
  const PIXEL_BUDGET = 90000;  // потолок пикселей низкоразрешающего буфера
  const MIN_STEP = 3;          // экранных px на пиксель буфера — не мельче
  const MAX_STEP = 8;          // …и не крупнее (при большом зуме клетка ~48 px: ≥ 5 пикселей буфера на клетку не нужно)
  const AMP = 1.0;             // на сколько клеток шум сдвигает выборку дымки (запас полосы — 1 клетка)
  const CORE_LO = 0.05;        // тело: alpha = smoothstep(CORE_LO, CORE_HI, m); у границы (m = 0.5) ≈ 0.7,
  const CORE_HI = 0.75;        // а на ~0.25 клетки вглубь — полностью закрыто
  const MIST_MAX = 0.62;       // потолок непрозрачности дымки
  const FPS_FULL = 20;         // на 60 Гц это каждый 3-й кадр (24 всё равно округлялось бы до 20)
  const FPS_HALF = 10;
  const SLOW_SHARE = 0.25;     // кадр анимации (draw() целиком) занимает больше этой доли интервала между кадрами — упрощаем
  const STATIC_T = 7.3;        // момент шума для статичного кадра (подобран по виду)
  const OFFSET = 1 << 20;      // кратно 256: индексы шума остаются положительными при любых координатах
  const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

  const reducedQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const isReduced = () => !!(reducedQuery && reducedQuery.matches);

  let enabled = readEnabled();
  let mode = 'full';           // 'full' | 'half' | 'static' — авто-деградация
  let forced = null;           // тесты: принудительный режим
  let ema = 0;
  let emaFrames = 0;
  let noise = null;            // Uint8Array TILE×TILE, строится при первой отрисовке
  let lastMs = 0;              // время последнего fogFx.draw (для debug)
  let lastBand = 0;

  // ---- Кэш, зависящий от тумана и окна клеток (пересчитывается, когда map.js говорит dirty) ----
  let blurA = null;            // Float32Array — промежуточный буфер блюра
  let blurB = null;
  let blur = null;             // Uint8Array 0..255 — размытая сетка
  let cls = null;              // Uint8Array: 0 пусто, 1 полоса, 2 глубина
  let deepPath = null;
  let bandCount = 0;
  let gridW = 0;
  let gridH = 0;

  // ---- Низкоразрешающий буфер ----
  let low = null;
  let lowCtx = null;
  let img = null;
  let buf32 = null;
  let lw = 0;
  let lh = 0;
  let step = 4;
  // Тело тумана не зависит от времени: считается, только когда меняется камера, размер, шаг или сетка (gridRev).
  let coreA = null;            // Float32Array lw×lh
  let coreKey = '';
  let gridRev = 0;
  const coreTab = new Float32Array(257); // m (шаг 1/256) → alpha тела

  // ---- Цвета из токенов темы ----
  let colorKey = '';
  const col = { bg: [11, 14, 19], mist: [140, 160, 175] };
  let pctx = null;

  function readEnabled() {
    try { return localStorage.getItem(STORAGE_KEY) !== '1'; } catch (e) { return true; }
  }

  function parseColor(css, fallback) {
    try {
      if (!pctx) {
        const c = document.createElement('canvas');
        c.width = 1; c.height = 1;
        pctx = c.getContext('2d', { willReadFrequently: true });
      }
      pctx.clearRect(0, 0, 1, 1);
      pctx.fillStyle = '#000';
      pctx.fillStyle = css;
      pctx.fillRect(0, 0, 1, 1);
      const d = pctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    } catch (e) { return fallback; }
  }

  function updateColors(theme) {
    const key = `${theme.bg}|${theme.text}|${theme.accent}`;
    if (key === colorKey) return;
    colorKey = key;
    const bg = parseColor(theme.bg, col.bg);
    const text = parseColor(theme.text, [229, 235, 243]);
    const accent = parseColor(theme.accent, [121, 198, 238]);
    const mix = (a, b, k) => [0, 1, 2].map((i) => a[i] * (1 - k) + b[i] * k);
    col.bg = bg;
    col.mist = mix(mix(bg, text, 0.62), accent, 0.22).map(Math.round);
  }

  // ---- Бесшовный шум: три октавы значений решётки со сглаженной интерполяцией ----
  function buildNoise() {
    const T = TILE;
    const acc = new Float32Array(T * T);
    let seed = 1337;
    const rnd = () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    [[4, 0.55], [8, 0.3], [16, 0.15]].forEach(([n, weight]) => {
      const lat = new Float32Array(n * n);
      for (let i = 0; i < lat.length; i++) lat[i] = rnd();
      for (let y = 0; y < T; y++) {
        const fy = (y / T) * n;
        const y0 = Math.floor(fy);
        const ty0 = fy - y0;
        const ty = ty0 * ty0 * (3 - 2 * ty0);
        const ya = (y0 % n) * n;
        const yb = ((y0 + 1) % n) * n;
        for (let x = 0; x < T; x++) {
          const fx = (x / T) * n;
          const x0 = Math.floor(fx);
          const tx0 = fx - x0;
          const tx = tx0 * tx0 * (3 - 2 * tx0);
          const xa = x0 % n;
          const xb = (x0 + 1) % n;
          const top = lat[ya + xa] * (1 - tx) + lat[ya + xb] * tx;
          const bottom = lat[yb + xa] * (1 - tx) + lat[yb + xb] * tx;
          acc[y * T + x] += weight * (top * (1 - ty) + bottom * ty);
        }
      }
    });
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < acc.length; i++) { if (acc[i] < lo) lo = acc[i]; if (acc[i] > hi) hi = acc[i]; }
    const out = new Uint8Array(T * T);
    const k = 255 / (hi - lo || 1);
    for (let i = 0; i < out.length; i++) out[i] = Math.round((acc[i] - lo) * k);
    return out;
  }

  // ---- Подготовка по туману: размытая копия, классы клеток, путь «глубины» ----
  function rebuild(cells, w, h, i0, j0, cellSize, yOff) {
    const n = w * h;
    if (!blur || blur.length < n) {
      blurA = new Float32Array(n);
      blurB = new Float32Array(n);
      blur = new Uint8Array(n);
      cls = new Uint8Array(n);
    }
    gridW = w;
    gridH = h;
    gridRev++;
    // Бокс 3×3 дважды (поддержка ±2 клетки), края окна — «продолжение» (clamp). Итог — в blurA.
    boxBlur(cells, blurA, blurB, w, h);
    boxBlur(blurB, blurB, blurA, w, h);
    for (let i = 0; i < n; i++) blur[i] = Math.round(blurA[i] * 255);
    // Классы: рядом с границей (и на ~1 клетку дальше — запас под смещение шума) — «полоса».
    bandCount = 0;
    for (let y = 0; y < h; y++) {
      const ya = Math.max(0, y - 1) * w;
      const yc = y * w;
      const yb = Math.min(h - 1, y + 1) * w;
      for (let x = 0; x < w; x++) {
        const xa = Math.max(0, x - 1);
        const xb = Math.min(w - 1, x + 1);
        let mn = 255;
        let mx = 0;
        for (let k = 0; k < 9; k++) {
          const v = blur[(k < 3 ? ya : k < 6 ? yc : yb) + (k % 3 === 0 ? xa : k % 3 === 1 ? x : xb)];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const c = mx === 0 ? 0 : (mn === 255 ? 2 : 1);
        cls[yc + x] = c;
        if (c === 1) bandCount++;
      }
    }
    // Кольцо (3): клетки глубины, соседние с полосой. Их тоже считает шейдер — он там даёт непрозрачный
    // фон, а векторная заливка лежит под ним. Без кольца буфер при растяжении сходил бы на нет ровно по
    // краю векторной заливки и по стыку виднелась бы обводка (в полосе читается картинка карты).
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (cls[y * w + x] !== 2) continue;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < w && cls[yy * w + xx] === 1) { near = true; break; }
          }
        }
        if (near) cls[y * w + x] = 3;
      }
    }
    // Глубина (включая кольцо): подряд идущие клетки строки — один прямоугольник; всё одним Path2D
    // (иначе на стыках щели).
    const path = new Path2D();
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        if (cls[y * w + x] < 2) { x++; continue; }
        let x1 = x;
        while (x1 + 1 < w && cls[y * w + x1 + 1] >= 2) x1++;
        path.rect((i0 + x) * cellSize, (j0 + y) * cellSize + yOff, (x1 - x + 1) * cellSize, cellSize);
        x = x1 + 1;
      }
    }
    deepPath = path;
  }

  // Бокс 3×3 разделимо: src → tmp (по X) → dst (по Y). src и tmp могут быть одним массивом: строка
  // сначала считается в rowBuf и только потом записывается.
  function boxBlur(src, tmp, dst, w, h) {
    const third = 1 / 3;
    const rowBuf = new Float32Array(w);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const xa = x > 0 ? x - 1 : 0;
        const xb = x < w - 1 ? x + 1 : w - 1;
        rowBuf[x] = (src[row + xa] + src[row + x] + src[row + xb]) * third;
      }
      for (let x = 0; x < w; x++) tmp[row + x] = rowBuf[x];
    }
    for (let y = 0; y < h; y++) {
      const ya = (y > 0 ? y - 1 : 0) * w;
      const yb = (y < h - 1 ? y + 1 : h - 1) * w;
      const yc = y * w;
      for (let x = 0; x < w; x++) dst[yc + x] = (tmp[ya + x] + tmp[yc + x] + tmp[yb + x]) * third;
    }
  }

  // Шаг буфера (экранных px на пиксель): не больше бюджета пикселей и не мельче, чем нужно клетке на экране
  // (при большом зуме клетка ~48 px, буферу хватает ~5 пикселей на клетку — тело и дымка плавные, считать их нет смысла чаще).
  function pickStep(w, h, cellPx) {
    const budget = Math.max(MIN_STEP, Math.ceil(Math.sqrt((w * h) / PIXEL_BUDGET)));
    const byCell = Math.min(MAX_STEP, Math.max(MIN_STEP, Math.round(cellPx / 5)));
    return Math.max(budget, byCell);
  }

  function ensureLow(w, h, cellPx) {
    const step0 = pickStep(w, h, cellPx);
    const nw = Math.ceil(w / step0);
    const nh = Math.ceil(h / step0);
    if (low && nw === lw && nh === lh && step0 === step) return;
    step = step0;
    lw = nw;
    lh = nh;
    if (!low) { low = document.createElement('canvas'); lowCtx = low.getContext('2d'); }
    low.width = lw;
    low.height = lh;
    img = lowCtx.createImageData(lw, lh);
    buf32 = new Uint32Array(img.data.buffer);
  }

  const smooth = (a, b, x) => {
    const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
    return t * t * (3 - 2 * t);
  };
  for (let i = 0; i <= 256; i++) coreTab[i] = smooth(CORE_LO, CORE_HI, i / 256);

  // Полоса: пишет пиксели в buf32. Окно клеток шире экрана на FOG_FX_MARGIN_CELLS (4), поэтому выборки
  // по центрам клеток (смещение шума ≤ 1 клетка) не выходят за массив; для надёжности координаты зажаты
  // одним сравнением (дешевле, чем clamp каждого из четырёх индексов).
  function renderBand(cells, o, t) {
    const { i0, j0, cellSize, yOff, cam, w, h } = o;
    const zoom = cam.zoom;
    const W = gridW;
    const maxU = gridW - 2;
    const maxV = gridH - 2;
    const du = step / (zoom * cellSize);                       // клеток на пиксель буфера
    // Тело зависит только от камеры, размера, шага и сетки — считаем, когда они поменялись.
    const key = `${cam.x}|${cam.y}|${zoom}|${w}|${h}|${step}|${gridRev}`;
    const calcCore = key !== coreKey || !coreA || coreA.length !== lw * lh;
    if (calcCore) {
      if (!coreA || coreA.length !== lw * lh) coreA = new Float32Array(lw * lh);
      coreKey = key;
    }
    const u0 = (((0.5 * step - w / 2) / zoom + cam.x) / cellSize) - i0;
    const v0 = (((0.5 * step - h / 2) / zoom + cam.y - yOff) / cellSize) - j0;
    // Сдвиги шума во времени (текселей): два слоя дрейфуют в разные стороны — поле смещений «переливается».
    const T16 = TEX_PER_CELL;
    const oAx = OFFSET + t * 0.18 * T16;
    const oAy = OFFSET + t * 0.08 * T16;
    const oBx = OFFSET - t * 0.11 * T16;
    const oBy = OFFSET + t * 0.14 * T16;
    const oCx = OFFSET + t * 0.06 * T16;
    const oCy = OFFSET - t * 0.05 * T16;
    const nz = noise;
    const bgR = col.bg[0];
    const bgG = col.bg[1];
    const bgB = col.bg[2];
    const miR = col.mist[0];
    const miG = col.mist[1];
    const miB = col.mist[2];
    buf32.fill(0);
    for (let py = 0; py < lh; py++) {
      const v = v0 + py * du;
      if (v < 0 || v >= gridH) continue;
      const rowCls = (v | 0) * W;
      for (let px = 0; px < lw; px++) {
        const u = u0 + px * du;
        if (u < 0 || u >= W || (cls[rowCls + (u | 0)] & 1) === 0) continue; // 1 — полоса, 3 — кольцо глубины
        const pi = py * lw + px;
        // Мировые тексели шума (привязка к карте: при панораме дымка не скользит).
        const gx = (u + i0) * T16;
        const gy = (v + j0) * T16;
        const dX = (nz[((((gy + oAy) | 0) & 255) << 8) + (((gx + oAx) | 0) & 255)] + nz[((((gy + oBy + 61) | 0) & 255) << 8) + (((gx + oBx + 97) | 0) & 255)] - 255) * (1 / 255);
        const dY = (nz[((((gy + oAy + 113) | 0) & 255) << 8) + (((gx + oAx + 71) | 0) & 255)] + nz[((((gy + oBy + 29) | 0) & 255) << 8) + (((gx + oBx + 151) | 0) & 255)] - 255) * (1 / 255);
        const cloud = nz[((((gy * 0.6 + oCy) | 0) & 255) << 8) + (((gx * 0.6 + oCx) | 0) & 255)] * (1 / 255);
        // Дымка: размытая сетка по смещённым координатам (билинейно по центрам клеток); вес — «острота» границы
        // (тент вокруг m = 0.5).
        let fu = u + dX * AMP - 0.5;
        let fv = v + dY * AMP - 0.5;
        if (fu < 0) fu = 0; else if (fu > maxU) fu = maxU;
        if (fv < 0) fv = 0; else if (fv > maxV) fv = maxV;
        const x0 = fu | 0;
        const y0 = fv | 0;
        const tx = fu - x0;
        const ty = fv - y0;
        const i00 = y0 * W + x0;
        const mb = ((blur[i00] * (1 - tx) + blur[i00 + 1] * tx) * (1 - ty) + (blur[i00 + W] * (1 - tx) + blur[i00 + W + 1] * tx) * ty) * (1 / 255);
        const tent = 1 - Math.abs(2 * mb - 1);
        const puff = cloud * cloud * (3 - 2 * cloud);   // клубы: контрастнее, чем просто шум
        const aM = MIST_MAX * tent * (0.12 + 0.88 * puff);
        // Тело тумана: сетка без смещения; от времени не зависит — берём из кэша, пока камера и туман те же.
        let aC;
        if (calcCore) {
          let su = u - 0.5;
          let sv = v - 0.5;
          if (su < 0) su = 0; else if (su > maxU) su = maxU;
          if (sv < 0) sv = 0; else if (sv > maxV) sv = maxV;
          const cx0 = su | 0;
          const cy0 = sv | 0;
          const sx = su - cx0;
          const sy = sv - cy0;
          const j00 = cy0 * W + cx0;
          const m = (cells[j00] * (1 - sx) + cells[j00 + 1] * sx) * (1 - sy) + (cells[j00 + W] * (1 - sx) + cells[j00 + W + 1] * sx) * sy;
          aC = coreTab[(m * 256) | 0];
          coreA[pi] = aC;
        } else {
          aC = coreA[pi];
        }
        const outA = aM + aC * (1 - aM);
        if (outA < 0.004) continue;
        const k = aC * (1 - aM);
        const lift = 0.85 + 0.3 * cloud;               // дымка местами чуть светлее
        const inv = 1 / outA;
        const r = (Math.min(255, miR * lift) * aM + bgR * k) * inv;
        const g = (Math.min(255, miG * lift) * aM + bgG * k) * inv;
        const b = (Math.min(255, miB * lift) * aM + bgB * k) * inv;
        buf32[pi] = ((outA * 255 + 0.5) << 24) | ((b + 0.5) << 16) | ((g + 0.5) << 8) | ((r + 0.5) | 0);
      }
    }
  }

  // ---- Публичное ----
  function animationOn() {
    return enabled && !isReduced() && effectiveMode() !== 'static';
  }
  function effectiveMode() { return forced || mode; }
  function targetFps() {
    const m = effectiveMode();
    return m === 'full' ? FPS_FULL : m === 'half' ? FPS_HALF : 0;
  }

  // opts: { cells (Uint8Array, 1 = скрыта), gridW, gridH, i0, j0, cellSize, yOff, cam {x,y,zoom}, w, h,
  //         theme {bg,text,accent}, now (мс), dirty }
  // Возвращает { animating } — нужны ли следующие кадры (есть полоса и анимация включена).
  function draw(ctx, o) {
    const t0 = performance.now();
    if (!noise) noise = buildNoise();
    updateColors(o.theme);
    if (o.dirty || !cls || gridW !== o.gridW || gridH !== o.gridH) rebuild(o.cells, o.gridW, o.gridH, o.i0, o.j0, o.cellSize, o.yOff);
    ensureLow(o.w, o.h, o.cellSize * o.cam.zoom);
    const animate = animationOn();
    const t = animate ? o.now / 1000 : STATIC_T;
    ctx.save();
    ctx.setTransform(o.cam.zoom, 0, 0, o.cam.zoom, o.w / 2 - o.cam.x * o.cam.zoom, o.h / 2 - o.cam.y * o.cam.zoom);
    ctx.fillStyle = `rgb(${col.bg[0]},${col.bg[1]},${col.bg[2]})`;
    ctx.fill(deepPath);
    if (bandCount) {
      renderBand(o.cells, o, t);
      lowCtx.putImageData(img, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(low, 0, 0, lw, lh, 0, 0, lw * step, lh * step);
    }
    ctx.restore();
    lastBand = bandCount;
    lastMs = performance.now() - t0;
    return { animating: bandCount > 0 && animate };
  }

  // map.js сообщает время всего draw() кадра анимации: слишком долго — упрощаем.
  function noteFrame(ms) {
    if (forced) return;
    ema = emaFrames === 0 ? ms : ema * 0.9 + ms * 0.1;
    emaFrames++;
    const need = mode === 'full' ? FPS_FULL : FPS_HALF; // примерно секунда кадров
    const limit = (1000 / need) * SLOW_SHARE;           // 12.5 мс при 20 кадрах/с, 25 мс при 10
    if (mode !== 'static' && emaFrames >= need && ema > limit) {
      mode = mode === 'full' ? 'half' : 'static';
      ema = 0;
      emaFrames = 0;
      try { console.info('[fogFx] тяжёлый кадр, туман упрощён:', mode); } catch (e) { /* без консоли */ }
      emitChange();
    }
  }

  function snapshot() {
    return { enabled, reduced: isReduced(), mode: effectiveMode() };
  }
  function emitChange() {
    document.dispatchEvent(new CustomEvent('fogfx:change', { detail: snapshot() }));
  }
  function setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem(STORAGE_KEY, enabled ? '0' : '1'); } catch (e) { /* приватный режим */ }
    emitChange();
  }
  if (reducedQuery && reducedQuery.addEventListener) reducedQuery.addEventListener('change', emitChange);

  window.fogFx = {
    available: LITTLE_ENDIAN,
    draw,
    noteFrame,
    targetFps,
    animationOn,
    setEnabled,
    get: snapshot,
    // Тесты: принудительный режим 'full' | 'half' | 'static' (null — снять).
    force(m) { forced = m || null; emitChange(); },
    // Тесты: сбросить авто-упрощение и принудительный режим.
    reset() { mode = 'full'; forced = null; ema = 0; emaFrames = 0; emitChange(); },
    debug() {
      return { ...snapshot(), forced, ema, emaFrames, lastMs, bandCells: lastBand, gridW, gridH, step, lw, lh };
    },
  };
})();
