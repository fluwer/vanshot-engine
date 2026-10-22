// Блок «ресурсы»: FPS и прочее — чтобы видеть, где тормозит. Есть у ГМа и у игрока; включён по умолчанию, выключается в
// пункте «Вид» (личная настройка устройства: localStorage['perf:hud'] = '0' — выключено). Пока блок скрыт, ничего не
// считается: ни rAF-цикла, ни пинга, ни замеров в карте.
//
// Что показывает (обновляется дважды в секунду):
//   FPS и время кадра — по requestAnimationFrame страницы (среднее и худший кадр за секунду): это то, что видит человек;
//   Карта (JS) — сглаженная цена JS-части draw() (mapController.getPerf) и разбивка по секциям; растеризация идёт позже и в
//     эти миллисекунды не входит — её отражает FPS; плюс число отрисовок в секунду;
//   Погода — цена кадра погоды; Память — куча JS (performance.memory, только Chromium); Пинг — круг до сервера (событие net:ping);
//   Сцена (только ГМ) — картинок, клеток тумана, фишек.
//
// window.PerfHud: init({ socket, getMap, gm }), isVisible(), setVisible(bool), debug(); событие document 'perfhud:change'
// (detail = { visible }) для Vue (src/gm-panel/usePerfHud.js).
(function () {
  const KEY = 'perf:hud';
  const RENDER_EVERY_MS = 500;
  const PING_EVERY_MS = 2000;
  const MAX_GAP_MS = 500; // дольше — вкладка была скрыта, а не кадр тормозил

  let el = null;
  let cells = null;       // { fps, frame, map, parts, draws, weather, mem, ping, scene } — узлы значений
  let socket = null;
  let getMap = () => null;
  let isGm = false;
  let visible = readVisible();
  let rafId = 0;
  let pingTimer = 0;
  let lastFrame = 0;
  let lastRender = 0;
  let frames = [];        // { t, dt } за последнюю секунду
  let ping = null;
  let prevDraws = 0;
  let prevDrawsAt = 0;
  let snapshot = null;    // последние показанные значения (для debug и тестов)

  function readVisible() {
    try { return localStorage.getItem(KEY) !== '0'; } catch (e) { return true; }
  }

  function build() {
    el.textContent = '';
    cells = {};
    const row = (key, label, sub) => {
      const r = document.createElement('div');
      r.className = sub ? 'perf-sub' : 'perf-row';
      if (!sub) {
        const k = document.createElement('span');
        k.className = 'perf-k';
        k.textContent = label;
        r.appendChild(k);
      }
      const v = document.createElement('span');
      v.className = sub ? 'perf-subv' : 'perf-v';
      r.appendChild(v);
      el.appendChild(r);
      cells[key] = v;
    };
    row('fps', 'FPS');
    row('frame', 'Кадр');
    row('map', 'Карта (JS)');
    row('parts', '', true);
    row('draws', 'Отрисовок/с');
    row('weather', 'Погода');
    row('mem', 'Память');
    row('ping', 'Пинг');
    if (isGm) row('scene', 'Сцена');
  }

  const level = (v, good, warn, higherIsBetter) => {
    if (v === null || !Number.isFinite(v)) return '';
    const ok = higherIsBetter ? v >= good : v <= good;
    const mid = higherIsBetter ? v >= warn : v <= warn;
    return ok ? 'perf-good' : mid ? 'perf-warn' : 'perf-bad';
  };
  const set = (key, text, cls) => {
    const c = cells[key];
    if (!c) return;
    c.textContent = text;
    c.className = (c.className.split(' ')[0]) + (cls ? ` ${cls}` : '');
  };
  const ms = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');

  // Блок стоит над нижней панелью: её высота зависит от масштаба интерфейса и ширины окна (панель может перенестись на
  // вторую строку), поэтому нижний край берём из её фактического положения; нет панели (игрок до входа) — отступ из CSS.
  function place() {
    const bar = document.querySelector('.action-bar');
    const r = bar ? bar.getBoundingClientRect() : null;
    if (r && r.height > 0) el.style.bottom = `${Math.round(window.innerHeight - r.top + 10)}px`;
    else el.style.bottom = '';
  }

  function render(now) {
    if (!cells) return;
    place();
    // FPS и кадр по окну в одну секунду
    let fps = null; let avg = null; let worst = null;
    if (frames.length > 2) {
      const span = frames[frames.length - 1].t - frames[0].t + frames[0].dt;
      fps = Math.round((frames.length * 1000) / span);
      avg = frames.reduce((s, f) => s + f.dt, 0) / frames.length;
      worst = Math.max(...frames.map((f) => f.dt));
    }
    set('fps', fps === null ? '—' : `${fps}`, level(fps, 50, 30, true));
    set('frame', avg === null ? '—' : `${ms(avg)} мс · худший ${Math.round(worst)}`, level(worst, 25, 50, false));

    // карта
    const mc = getMap();
    const perf = mc && mc.getPerf ? mc.getPerf() : null;
    if (mc && mc.setPerfMeter && perf && !perf.on) mc.setPerfMeter(true); // карта у игрока появляется после входа
    let drawsPerSec = null;
    if (perf && perf.on) {
      if (prevDrawsAt && now > prevDrawsAt) drawsPerSec = Math.round(((perf.draws - prevDraws) * 1000) / (now - prevDrawsAt));
      prevDraws = perf.draws;
      prevDrawsAt = now;
    } else { prevDrawsAt = 0; }
    set('map', perf && perf.on ? `${ms(perf.drawMs)} мс` : '—', perf && perf.on ? level(perf.drawMs, 4, 10, false) : '');
    set('parts', perf && perf.on
      ? `картинки ${ms(perf.parts.images)} · сетка ${ms(perf.parts.grid)} · туман ${ms(perf.parts.fog)} · прочее ${ms(perf.parts.tokens)}`
      : '');
    set('draws', drawsPerSec === null || drawsPerSec < 0 ? '—' : `${drawsPerSec}`);

    // погода
    const w = window.weather && window.weather.debug ? window.weather.debug() : null;
    set('weather', w && w.running ? `${ms(w.frameMs)} мс` : 'выкл');

    // память и пинг
    const mem = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
    set('mem', mem === null ? '—' : `${Math.round(mem)} МБ`);
    set('ping', ping === null ? '—' : `${Math.round(ping)} мс`, level(ping, 100, 250, false));

    if (isGm && perf) {
      set('scene', `${perf.counts.images} карт. · ${perf.counts.fogCells.toLocaleString('ru-RU')} кл. тумана · ${perf.counts.tokens} фишек`);
    }
    snapshot = { fps, avgMs: avg, worstMs: worst, mapMs: perf && perf.on ? perf.drawMs : null, parts: perf && perf.on ? perf.parts : null, drawsPerSec, ping, mem, counts: perf ? perf.counts : null };
  }

  function tick(now) {
    rafId = requestAnimationFrame(tick);
    if (lastFrame) {
      const dt = now - lastFrame;
      if (dt < MAX_GAP_MS) frames.push({ t: now, dt });
    }
    lastFrame = now;
    while (frames.length && now - frames[0].t > 1000) frames.shift();
    if (now - lastRender >= RENDER_EVERY_MS) {
      lastRender = now;
      render(now);
    }
  }

  function doPing() {
    if (!socket || !socket.connected) { ping = null; return; }
    const t0 = performance.now();
    socket.emit('net:ping', t0, () => { ping = performance.now() - t0; });
  }

  function start() {
    if (rafId || !el) return;
    lastFrame = 0;
    lastRender = 0;
    frames = [];
    rafId = requestAnimationFrame(tick);
    doPing();
    pingTimer = setInterval(doPing, PING_EVERY_MS);
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    clearInterval(pingTimer);
    pingTimer = 0;
    frames = [];
    ping = null;
    prevDrawsAt = 0;
    const mc = getMap();
    if (mc && mc.setPerfMeter) mc.setPerfMeter(false);
  }

  function apply() {
    if (!el) return;
    el.hidden = !visible;
    if (visible) start(); else stop();
  }

  function setVisible(v) {
    visible = !!v;
    try { localStorage.setItem(KEY, visible ? '1' : '0'); } catch (e) { /* приватный режим */ }
    apply();
    document.dispatchEvent(new CustomEvent('perfhud:change', { detail: { visible } }));
  }

  function init(opts) {
    socket = (opts && opts.socket) || null;
    getMap = (opts && opts.getMap) || (() => null);
    isGm = !!(opts && opts.gm);
    el = document.getElementById('perf-hud');
    if (!el) return;
    build();
    apply();
  }

  window.PerfHud = {
    init,
    isVisible: () => visible,
    setVisible,
    debug: () => ({ visible, running: !!rafId, snapshot, frames: frames.length }),
  };
}());
