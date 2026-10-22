// Снежный фон окна входа игрока: тёмное небо, дымка и три слоя снега (дальние мельче и бледнее).
// Небо, виньетка и сугробы — CSS (.login-bg в style.css, цвета из токенов); сюда рисуется только то, что
// движется: холст #login-bg-canvas внутри #login-bg под карточкой входа (position: fixed, клики пропускает).
//
// Свой rAF-цикл живёт, только пока окно входа на экране и вкладка на переднем плане; при входе игрока
// player.js зовёт loginFx.stop() — слой скрывается, цикл и буферы уходят. prefers-reduced-motion — один
// статичный кадр. Если кадр заметно дорог (слабая машина), снега становится меньше (до двух ступеней).
// Почему не weather.js: он привязан к холсту карты, камере и погоде ГМа; здесь снег всегда и один.
// window.loginFx: start, stop, debug.
(function () {
  const wrap = document.getElementById('login-bg');
  const canvas = document.getElementById('login-bg-canvas');
  const ctx = canvas ? canvas.getContext('2d') : null;
  if (!wrap || !ctx) {
    window.loginFx = { start() {}, stop() {}, debug: () => ({ running: false, stopped: true, particles: 0 }) };
    return;
  }

  const TAU = Math.PI * 2;
  const REF_AREA = 1366 * 768;
  const MAX_DT = 0.05;          // после паузы вкладки время не «прыгает»
  const DPR_MAX = 1.5;          // снег не требует чёткости: шестнадцатая доля пикселей экономит заливку
  const SLOW_MS = 6;            // кадр дороже (сглаженно) — разгружаем…
  const SLOW_FOR_S = 1;         // …если это держится около секунды
  const THIN_STEPS = [1, 0.6, 0.35]; // доля снежинок: обычно / облегчённо / минимум
  const reducedQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const isReduced = () => !!(reducedQuery && reducedQuery.matches);

  // Цвета — из токенов дизайн-системы (как в weather.js): снег — --text, дымка и мороз — --accent.
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
  const wrapAxis = (v, max, pad) => ((((v + pad) % (max + 2 * pad)) + (max + 2 * pad)) % (max + 2 * pad)) - pad;
  const gust = (t) => 0.8 + 0.3 * Math.sin(t * 0.37) + 0.2 * Math.sin(t * 0.91 + 1.3); // порывы: 0.3…1.3

  let w = 0;
  let h = 0;
  let dpr = 1;
  let parts = null;
  let rafId = 0;
  let last = 0;
  let clock = 0;
  let stopped = false;
  let frameMs = 0;       // сглаженная цена кадра (мс)
  let thinIdx = 0;
  let slowFor = 0;
  let resizeTimer = 0;

  function build() {
    const A = Math.min(2.2, Math.max(0.5, (w * h) / REF_AREA)) * THIN_STEPS[thinIdx];
    const flakes = [];
    for (let i = 0, n = Math.round(190 * A); i < n; i++) {
      flakes.push({ x: rand(0, w), y: rand(0, h), depth: rand(0.2, 1), phase: rand(0, TAU), freq: rand(0.25, 0.7), amp: rand(5, 12), k: rand(0.7, 1.3) });
    }
    const blobs = [];
    for (let i = 0; i < 4; i++) {
      blobs.push({ x: rand(0, w), y: rand(0.15 * h, 0.95 * h), r: rand(240, 460), speed: rand(8, 22), a: rand(0.035, 0.06) });
    }
    parts = { flakes, blobs };
  }

  // Размер холста по размеру слоя; смена размера пересоздаёт снег (редкое событие — изменение окна).
  function fit() {
    const cw = wrap.clientWidth || window.innerWidth;
    const ch = wrap.clientHeight || window.innerHeight;
    const nd = Math.min(DPR_MAX, window.devicePixelRatio || 1);
    if (cw !== w || ch !== h || nd !== dpr) {
      w = cw;
      h = ch;
      dpr = nd;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      parts = null;
    }
    if (!parts) build();
  }

  function draw(dt) {
    clock += dt;
    const g = gust(clock);
    ctx.clearRect(0, 0, w, h);
    // Медленная дымка: мягкие пятна, плывущие по ветру.
    parts.blobs.forEach((b) => {
      b.x = wrapAxis(b.x + b.speed * g * dt, w, b.r);
      const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      grad.addColorStop(0, rgba(color.snow, b.a));
      grad.addColorStop(1, rgba(color.snow, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
    });
    // Снежинки тремя слоями глубины: каждый слой — один path и одна заливка.
    const buckets = [[], [], []];
    parts.flakes.forEach((f) => {
      const vx = 6 * g * (0.5 + f.depth) + Math.cos(clock * f.freq * TAU + f.phase) * f.amp * f.freq * TAU;
      const vy = (14 + f.depth * 34) * f.k;
      f.x = wrapAxis(f.x + vx * dt, w, 12);
      f.y = wrapAxis(f.y + vy * dt, h, 12);
      buckets[f.depth < 0.5 ? 0 : f.depth < 0.8 ? 1 : 2].push(f);
    });
    const alphas = [0.32, 0.55, 0.82];
    buckets.forEach((list, b) => {
      if (!list.length) return;
      ctx.fillStyle = rgba(color.snow, alphas[b]);
      ctx.beginPath();
      list.forEach((f) => {
        const r = 0.9 + f.depth * 2;
        ctx.moveTo(f.x + r, f.y);
        ctx.arc(f.x, f.y, r, 0, TAU);
      });
      ctx.fill();
    });
  }

  function staticFrame() {
    if (stopped) return;
    fit();
    draw(0);
  }

  function frame(now) {
    rafId = 0;
    if (stopped || document.hidden || isReduced()) { last = 0; return; }
    const dt = last ? Math.min(MAX_DT, (now - last) / 1000) : 1 / 60;
    last = now;
    fit();
    const t0 = performance.now();
    draw(dt);
    frameMs = frameMs * 0.9 + (performance.now() - t0) * 0.1;
    if (frameMs > SLOW_MS) {
      slowFor += dt;
      if (slowFor > SLOW_FOR_S && thinIdx < THIN_STEPS.length - 1) { thinIdx++; parts = null; slowFor = 0; frameMs = 0; }
    } else {
      slowFor = 0;
    }
    rafId = requestAnimationFrame(frame);
  }

  function kick() {
    if (stopped || rafId || document.hidden) return;
    if (isReduced()) { staticFrame(); return; }
    rafId = requestAnimationFrame(frame);
  }

  function start() {
    stopped = false;
    wrap.classList.remove('hidden');
    last = 0;
    kick();
  }

  function stop() {
    stopped = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    clearTimeout(resizeTimer);
    parts = null;
    wrap.classList.add('hidden');
  }

  readColors();
  document.addEventListener('theme:change', () => { readColors(); if (isReduced()) staticFrame(); });
  document.addEventListener('visibilitychange', () => { last = 0; if (!document.hidden) kick(); });
  window.addEventListener('resize', () => {
    if (!isReduced()) return; // в движении холст подгоняется сам в следующем кадре
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(staticFrame, 120);
  });
  if (reducedQuery && reducedQuery.addEventListener) reducedQuery.addEventListener('change', () => { last = 0; kick(); });

  window.loginFx = {
    start,
    stop,
    // Для проверок: цикл идёт? остановлен? сколько снежинок, сглаженная цена кадра (мс), ступень облегчения.
    debug: () => ({
      running: !!rafId, stopped, reduced: isReduced(), particles: parts ? parts.flakes.length : 0,
      frameMs, thin: THIN_STEPS[thinIdx], w, h, dpr,
    }),
  };

  kick();
}());
