// Масштаб интерфейса (панели, блоки, журнал, модалки — не карта: у неё свой зум). Личная настройка устройства:
// localStorage['ui:scale'], 70…150%, шаг 5. Подключается синхронно в <head> (как game.js), чтобы страница
// сразу рисовалась в нужном размере, без мигания.
//
// Как работает: на :root ставится переменная --ui-scale, а CSS-свойство `zoom` с ней висит на контейнерах
// интерфейса (public/css/style.css, раздел «Масштаб интерфейса»). Раскладка рассчитана на ширину ≥ ~1000 логических
// пикселей, поэтому УВЕЛИЧЕНИЕ дополнительно ограничено шириной окна (innerWidth / 1000; уменьшение — без ограничений) и
// пересчитывается при изменении размера окна. Браузер без `zoom` (CSS.supports) — масштаб всегда 1, управление скрыто.
//
// window.UiScale: supported, MIN, MAX, STEP, get() → { chosen, effective, clamped }, set(v), onChange(fn);
// событие document 'uiscale:change' (detail = get()) для Vue (src/gm-panel/useUiScale.js).
(function () {
  const KEY = 'ui:scale';
  const MIN = 0.7;
  const MAX = 1.5;
  const STEP = 0.05;
  const MIN_LOGICAL_WIDTH = 1000; // раскладка не рассчитана на меньшую ширину после масштабирования
  const NARROW_LOGICAL_WIDTH = 1200; // ≤ этой логической ширины верхняя плашка уходит вправо от левого блока (CSS .ui-narrow)
  const supported = !!(window.CSS && CSS.supports && CSS.supports('zoom', '1.1'));

  const snap = (v) => Math.min(MAX, Math.max(MIN, Math.round(v / STEP) * STEP));
  const round2 = (v) => Math.round(v * 100) / 100;

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      const v = raw === null ? NaN : parseFloat(raw);
      return Number.isFinite(v) ? round2(snap(v)) : 1;
    } catch (e) { return 1; }
  }

  let chosen = read();

  // Увеличение не должно сужать «логическое» окно меньше MIN_LOGICAL_WIDTH; уменьшать можно всегда.
  function effective() {
    if (!supported) return 1;
    if (chosen <= 1) return chosen;
    return round2(Math.max(1, Math.min(chosen, window.innerWidth / MIN_LOGICAL_WIDTH)));
  }

  function snapshot() {
    const eff = effective();
    return { chosen, effective: eff, clamped: eff < chosen - 1e-6 };
  }

  const listeners = [];
  let lastEffective = null;
  // force — сообщить об изменении, даже если фактический масштаб прежний (пользователь выбрал другое значение).
  function apply(force) {
    const current = snapshot();
    const root = document.documentElement;
    root.style.setProperty('--ui-scale', String(current.effective));
    // «Узкий экран» считается по логической ширине (окно / масштаб): медиазапрос CSS смотрел бы на реальную.
    root.classList.toggle('ui-narrow', window.innerWidth / current.effective <= NARROW_LOGICAL_WIDTH);
    if (current.effective === lastEffective && force !== true) return;
    lastEffective = current.effective;
    document.dispatchEvent(new CustomEvent('uiscale:change', { detail: current }));
    listeners.forEach((fn) => { try { fn(current); } catch (err) { console.error(err); } });
  }

  function set(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    chosen = round2(snap(n));
    try { localStorage.setItem(KEY, String(chosen)); } catch (e) { /* приватный режим */ }
    apply(true);
  }

  window.addEventListener('resize', () => apply());
  apply(true);

  window.UiScale = {
    supported,
    MIN,
    MAX,
    STEP,
    get: snapshot,
    set,
    onChange(fn) { if (typeof fn === 'function') listeners.push(fn); },
  };
})();
