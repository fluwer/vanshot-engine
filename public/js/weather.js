// Погода на экране: холод, ветер, метель. Одна на всю игру — state.weather = { mode, intensity },
// задаёт ГМ (событие weather:set), рисует каждый клиент у себя.
//
// Отдельный холст #weather-canvas лежит НАД холстом карты (z-index 1, pointer-events: none — клики
// идут в карту) и рисуется своим циклом requestAnimationFrame: холст карты и его animLoop не
// трогаются, а когда погоды нет, цикл вообще остановлен. В конце каждого кадра погода «вычищается»
// под прямоугольниками всех картинок карты (destination-out по четырёхугольникам из
// mapController.getImageQuads — объединением, перекрытия картинок не «открывают» погоду),
// поэтому на картинках её не видно совсем, зато поверх фишек и сетки она есть.
//
// Личный выключатель — localStorage['weather:off'] (у каждого клиента свой); при
// prefers-reduced-motion не рисуется ничего. window.weather: onState, get, setEnabled, debug;
// событие document 'weather:change' (detail = get()) для Vue (src/gm-panel/useWeather.js).
(function () {
  const LABELS = { off: 'Нет', cold: 'Холод', wind: 'Ветер', blizzard: 'Метель' };
  const INTENSITY_K = { 1: 0.65, 2: 1, 3: 1.5 }; // слабо / средне / сильно: число и яркость частиц
  const STORAGE_KEY = 'weather:off';
  const FADE_OUT_S = 0.7;  // смена режима: старый гаснет…
  const FADE_IN_S = 1.0;   // …новый нарастает
  const MAX_DT = 0.05;     // после паузы вкладки время не «прыгает»
  const PARALLAX = 0.5;    // насколько частицы следуют за сдвигом камеры (по глубине слоя)
  const REF_AREA = 1366 * 768;
  const TAU = Math.PI * 2;

  const canvas = document.getElementById('weather-canvas');
  const ctx = canvas ? canvas.getContext('2d') : null;
  const reducedQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const isReduced = () => !!(reducedQuery && reducedQuery.matches);

  let server = { mode: 'off', intensity: 1 }; // что задал ГМ
  let enabled = readEnabled();
  let shownKey = 'off';  // что нарисовано сейчас: 'off' или 'режим:интенсивность'
  let level = 0;         // общая прозрачность 0…1 (переходы)
  let parts = null;      // частицы текущего режима
  let rafId = 0;
  let timerId = 0;
  let last = 0;          // время прошлого кадра
  let clock = 0;         // накопленное время (порывы, покачивание)
  let lastCam = null;
  let frameMs = 0;       // для проверки производительности (debug)

  // Цвета — из токенов дизайн-системы (как THEME в map.js): снег — --text, мороз — --accent.
  const color = { snow: [229, 235, 243], frost: [121, 198, 238] };
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const parse = (name, fallback) => {
      const m = /^#?([0-9a-f]{6})$/i.exec(cs.getPropertyValue(name).trim());
      return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : fallback;
    };
    color.snow = parse('--text', color.snow);
    color.frost = parse('--accent', color.frost);
  }
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
  const rand = (a, b) => a + Math.random() * (b - a);

  function readEnabled() {
    try { return localStorage.getItem(STORAGE_KEY) !== '1'; } catch (e) { return true; }
  }

  function snapshot() {
    return { mode: server.mode, intensity: server.intensity, enabled, reduced: isReduced(), label: LABELS[server.mode] };
  }
  function emitChange() {
    document.dispatchEvent(new CustomEvent('weather:change', { detail: snapshot() }));
  }

  // Что должно быть на экране: выключено ГМ, мной или системой (reduced-motion) — ничего.
  function wantedKey() {
    if (server.mode === 'off' || !enabled || isReduced()) return 'off';
    return `${server.mode}:${server.intensity}`;
  }

  // ---- Частицы ----
  function build(key, w, h) {
    const [mode, intensityStr] = key.split(':');
    const I = INTENSITY_K[Number(intensityStr)] || 1;
    const A = Math.min(2.2, Math.max(0.5, (w * h) / REF_AREA)); // число частиц ~ площади экрана
    const p = { mode, I, flakes: [], streaks: [], blobs: [] };
    // k — свой разброс скорости у каждой снежинки, чтобы поток не выглядел параллельными штрихами (дождём).
    const flake = (depthMin) => ({
      x: rand(0, w), y: rand(0, h), depth: rand(depthMin, 1), phase: rand(0, TAU), freq: rand(0.25, 0.7), amp: rand(5, 12), k: rand(0.7, 1.3),
    });
    if (mode === 'cold') {
      for (let i = 0, n = Math.round(70 * A * I); i < n; i++) p.flakes.push(flake(0.25));
    } else if (mode === 'wind') {
      for (let i = 0, n = Math.round(24 * A * I); i < n; i++) {
        p.streaks.push({ x: rand(0, w), y: rand(0, h), len: rand(110, 300), th: rand(1, 2.2), speed: rand(320, 640), a: rand(0.09, 0.22), phase: rand(0, TAU), depth: rand(0.3, 1) });
      }
      for (let i = 0, n = Math.round(30 * A * I); i < n; i++) p.flakes.push(flake(0.3));
    } else if (mode === 'blizzard') {
      for (let i = 0, n = Math.round(150 * A * I); i < n; i++) p.flakes.push(flake(0.2));
      for (let i = 0; i < 5; i++) {
        p.blobs.push({ x: rand(0, w), y: rand(0.1 * h, 0.9 * h), r: rand(260, 480), speed: rand(25, 60), a: rand(0.04, 0.06) });
      }
    }
    return p;
  }

  // Порывы ветра: плавная смесь двух синусоид, 0.3…1.3.
  const gust = (t) => 0.8 + 0.3 * Math.sin(t * 0.37) + 0.2 * Math.sin(t * 0.91 + 1.3);
  const wrap = (v, max, pad) => ((((v + pad) % (max + 2 * pad)) + (max + 2 * pad)) % (max + 2 * pad)) - pad;
  const bucketOf = (depth) => (depth < 0.5 ? 0 : depth < 0.8 ? 1 : 2);

  function vignette(w, h, strength) {
    const r1 = Math.hypot(w, h) / 2;
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, r1);
    g.addColorStop(0, rgba(color.frost, 0));
    g.addColorStop(1, rgba(color.frost, strength));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  // Снежинки тремя слоями глубины (дальние мельче и бледнее): каждый слой — один path и одна заливка.
  // trail > 0 — «смаз» по скорости (штрих вместо точки), для быстрых хлопьев ветра и метели.
  function drawFlakes(p, w, h, dt, pdx, pdy, g) {
    const mode = p.mode;
    const buckets = [[], [], []];
    p.flakes.forEach((f) => {
      let vx;
      let vy;
      if (mode === 'cold') {
        vx = 4 + Math.cos(clock * f.freq * TAU + f.phase) * f.amp * f.freq * TAU;
        vy = (8 + f.depth * 22) * f.k;
      } else if (mode === 'wind') {
        vx = (160 + 220 * f.depth) * g * f.k;
        vy = 8 + 22 * f.depth + Math.sin(clock * 1.3 + f.phase) * 10;
      } else {
        // метель: ветер почти горизонтальный, с порывами и завихрениями (вверх-вниз у каждой хлопьи по-своему)
        vx = (180 + 420 * f.depth) * g * f.k;
        vy = (40 + 110 * f.depth) * f.k + Math.sin(clock * 1.7 + f.phase) * 26;
      }
      f.x = wrap(f.x + (vx * dt) + pdx * f.depth, w, 12);
      f.y = wrap(f.y + (vy * dt) + pdy * f.depth, h, 12);
      f.vx = vx;
      f.vy = vy;
      buckets[bucketOf(f.depth)].push(f);
    });
    // Хлопья — округлые (штрих с круглыми концами и коротким хвостом по скорости), а не тонкие чёрточки:
    // иначе косой поток выглядит как дождь.
    const trail = mode === 'cold' ? 0 : (mode === 'wind' ? 0.02 : 0.012);
    const alphas = mode === 'cold' ? [0.3, 0.5, 0.75] : mode === 'wind' ? [0.22, 0.34, 0.5] : [0.28, 0.5, 0.8];
    buckets.forEach((list, b) => {
      if (!list.length) return;
      const a = alphas[b] * Math.min(1.2, 0.7 + p.I * 0.3);
      ctx.beginPath();
      if (trail) {
        ctx.strokeStyle = rgba(color.snow, a);
        ctx.lineCap = 'round';
        ctx.lineWidth = 1.2 + b * 1.3;
        list.forEach((f) => { ctx.moveTo(f.x, f.y); ctx.lineTo(f.x - f.vx * trail, f.y - f.vy * trail); });
        ctx.stroke();
      } else {
        ctx.fillStyle = rgba(color.snow, a);
        list.forEach((f) => {
          const r = 0.8 + f.depth * 1.5;
          ctx.moveTo(f.x + r, f.y);
          ctx.arc(f.x, f.y, r, 0, TAU);
        });
        ctx.fill();
      }
    });
  }

  // Длинные тонкие штрихи ветра слева направо, с лёгким изгибом и затуханием к концам.
  function drawStreaks(p, w, h, dt, pdx, pdy, g) {
    const cosA = Math.cos(0.14);
    const sinA = Math.sin(0.14);
    ctx.lineCap = 'round';
    p.streaks.forEach((s) => {
      s.x = wrap(s.x + s.speed * g * cosA * dt + pdx * s.depth, w, s.len);
      s.y = wrap(s.y + s.speed * g * sinA * dt + pdy * s.depth, h, 20);
      const hx = s.x + cosA * s.len / 2;
      const hy = s.y + sinA * s.len / 2;
      const tx = s.x - cosA * s.len / 2;
      const ty = s.y - sinA * s.len / 2;
      const bend = Math.sin(clock * 0.8 + s.phase) * 12;
      const grad = ctx.createLinearGradient(tx, ty, hx, hy);
      const a = Math.min(0.26, s.a * p.I);
      grad.addColorStop(0, rgba(color.frost, 0));
      grad.addColorStop(0.55, rgba(color.snow, a));
      grad.addColorStop(1, rgba(color.snow, 0));
      ctx.strokeStyle = grad;
      ctx.lineWidth = s.th;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.quadraticCurveTo(s.x - sinA * bend, s.y + cosA * bend, hx, hy);
      ctx.stroke();
    });
  }

  // Медленная дымка метели: мягкие пятна, плывущие по ветру.
  function drawBlobs(p, w, dt, g) {
    p.blobs.forEach((b) => {
      b.x = wrap(b.x + b.speed * g * dt, w, b.r);
      const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      grad.addColorStop(0, rgba(color.snow, b.a * Math.min(1.15, p.I))); // дымка не густеет выше «средне»+
      grad.addColorStop(1, rgba(color.snow, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
    });
  }

  // Вырез: стираем погоду под всеми картинками карты (объединением; обводка 3 px — по 1.5 px
  // в каждую сторону — закрывает сглаженный край, чтобы на самой границе не оставалось слабой каймы).
  function cutOutImages(mc, view, w, h) {
    const quads = mc && mc.getImageQuads ? mc.getImageQuads() : null;
    if (!view || !quads || !quads.length) return;
    const kx = w / view.w;
    const ky = h / view.h;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    quads.forEach((q) => {
      q.forEach((pt, i) => {
        const sx = (view.w / 2 + (pt.x - view.x) * view.zoom) * kx;
        const sy = (view.h / 2 + (pt.y - view.y) * view.zoom) * ky;
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      });
      ctx.closePath();
    });
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function getMapController() {
    return (window.gmBridge && window.gmBridge.mapController) || (window.playerBridge && window.playerBridge.mapController) || null;
  }

  function drawFrame(dt, w, h) {
    const mc = getMapController();
    const view = mc && mc.getView ? mc.getView() : null;
    // Сдвиг камеры двигает частицы чуть-чуть (по глубине): погода живёт вместе с картой, но не липнет к ней.
    let pdx = 0;
    let pdy = 0;
    if (view) {
      if (lastCam) {
        const clampPx = (v) => Math.max(-200, Math.min(200, v));
        pdx = clampPx(-(view.x - lastCam.x) * view.zoom * PARALLAX);
        pdy = clampPx(-(view.y - lastCam.y) * view.zoom * PARALLAX);
      }
      lastCam = { x: view.x, y: view.y };
    } else {
      lastCam = null;
    }
    clock += dt;
    const g = gust(clock);
    const p = parts;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = level;
    if (p.mode === 'cold') {
      vignette(w, h, Math.min(0.26, 0.14 * p.I * (0.85 + 0.15 * Math.sin(clock * 0.9))));
    } else if (p.mode === 'wind') {
      vignette(w, h, Math.min(0.12, 0.07 * p.I));
    } else if (p.mode === 'blizzard') {
      drawBlobs(p, w, dt, g);
      vignette(w, h, Math.min(0.2, 0.14 * p.I));
    }
    if (p.streaks.length) drawStreaks(p, w, h, dt, pdx, pdy, g);
    if (p.flakes.length) drawFlakes(p, w, h, dt, pdx, pdy, g);
    ctx.globalAlpha = 1;
    cutOutImages(mc, view, w, h);
  }

  function kick() {
    if (!ctx || rafId || timerId) return;
    rafId = requestAnimationFrame(frame);
  }

  function frame(now) {
    rafId = 0;
    const dt = last ? Math.min(MAX_DT, (now - last) / 1000) : 1 / 60;
    last = now;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) { // игрок до входа: холст скрыт — проверяем изредка, без rAF
      last = 0;
      timerId = setTimeout(() => { timerId = 0; kick(); }, 400);
      return;
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      parts = null;
    }
    const target = wantedKey();
    if (target !== shownKey) {
      level -= dt / FADE_OUT_S;
      if (level <= 0) { level = 0; shownKey = target; parts = null; }
    } else if (shownKey !== 'off' && level < 1) {
      level = Math.min(1, level + dt / FADE_IN_S);
    }
    if (shownKey === 'off') { // нечего рисовать и нечего гасить — цикл останавливается
      ctx.clearRect(0, 0, w, h);
      last = 0;
      lastCam = null;
      return;
    }
    if (!parts) parts = build(shownKey, w, h);
    const t0 = performance.now();
    drawFrame(dt, w, h);
    frameMs = frameMs * 0.9 + (performance.now() - t0) * 0.1;
    rafId = requestAnimationFrame(frame);
  }

  // ---- Публичный API ----
  function onState(state) {
    const w = state && state.weather;
    if (!w) return;
    const mode = LABELS[w.mode] ? w.mode : 'off';
    const intensity = INTENSITY_K[w.intensity] ? w.intensity : 1;
    if (mode === server.mode && intensity === server.intensity) return;
    server = { mode, intensity };
    emitChange();
    kick();
  }

  function setEnabled(on) {
    enabled = !!on;
    try {
      if (enabled) localStorage.removeItem(STORAGE_KEY); else localStorage.setItem(STORAGE_KEY, '1');
    } catch (e) { /* приватный режим — настройка живёт до перезагрузки */ }
    emitChange();
    kick();
  }

  if (ctx) {
    readColors();
    document.addEventListener('visibilitychange', () => { last = 0; if (!document.hidden) kick(); });
    if (reducedQuery && reducedQuery.addEventListener) {
      reducedQuery.addEventListener('change', () => { emitChange(); kick(); });
    }
  }

  window.weather = {
    onState,
    setEnabled,
    get: snapshot,
    labels: LABELS,
    // Для проверок: цикл идёт? что нарисовано, прозрачность, среднее время кадра (мс).
    debug: () => ({ running: !!(rafId || timerId), shownKey, level, frameMs, particles: parts ? parts.flakes.length + parts.streaks.length : 0 }),
  };
}());
