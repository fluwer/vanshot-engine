// Динамичные кубики: каждый бросок — отдельный d20, который влетает с края экрана,
// кувыркается, отскакивает и ложится в свою точку (у всех клиентов одинаковую —
// её выбирает сервер и кладёт в запись лога, entry.throw); несколько кубиков от
// разных игроков лежат одновременно. Обычный не-модульный скрипт, без сборки.
//
// Сигнал — дифф state.diceLog: показываем все записи, которых клиент ещё не
// видел (а не только diceLog[0], как раньше). Первый state и первый после
// реконнекта молча помечают историю виденной, поэтому после перезагрузки
// страницы старые броски не проигрываются заново.
//
// dice.js (initDiceStage/formatDiceEntry) здесь не используется: initDiceStage
// нужен combatfx.js для кубиков инициативы при старте боя, formatDiceEntry — логу.
(function () {
  const layer = document.getElementById('dice-layer');
  if (!layer) {
    window.diceFx = { onState() {}, skipNext() {} };
    return;
  }

  const MAX_DICE = 6;        // одновременно на экране; лишний вытесняет самый старый
  const FLY_MS = 1300;       // полёт до посадки
  const REST_MS = 4500;      // сколько кубик лежит после посадки
  const FADE_MS = 600;       // плавное исчезание
  const EVICT_FADE_MS = 200; // быстрое исчезание вытесненного/очищенного кубика
  const HIDDEN_REPLAY_MS = 15000; // броски, пришедшие в фоновое окно, проигрываем при возврате, если не старше
  const MAX_WAITING = 30;    // потолок очереди отложенных бросков (лог всё равно хранит 30)
  const LAYOUT_RETRIES = 6;  // сколько раз повторять, если слой ещё не размечен (размер 0)
  const LAYOUT_RETRY_MS = 150;
  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  let seen = new Set();   // id записей, которые уже показаны (или пропущены осознанно)
  let initialized = false;
  let skipNextFlag = false;
  let lastLocationId = null;
  const active = [];      // { el, timers, intervals, removed }
  const waiting = [];     // { entry, at } — броски, пришедшие, пока окно было в фоне
  const retryTimers = new Set(); // отложенные повторы spawnDie (слой без размера)

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  // ---- Детерминированный генератор (для старых записей без entry.throw) ----
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function throwOf(entry) {
    if (entry.throw) return entry.throw;
    const r = mulberry32(fnv1a(String(entry.id)));
    return { x: 0.1 + r() * 0.8, y: 0.15 + r() * 0.62, from: Math.floor(r() * 4), seed: Math.floor(r() * 1e9) };
  }

  // ---- Звук: небольшой пул, чтобы несколько бросков подряд не обрывали друг друга ----
  const SOUND_URL = 'assets/sfx/dice-roll.mp3';
  const pool = [];
  let poolIdx = 0;
  function playRollSound(activeCount) {
    try {
      if (!pool.length) {
        for (let i = 0; i < 4; i += 1) {
          const a = new Audio(SOUND_URL);
          a.preload = 'auto';
          pool.push(a);
        }
      }
      const a = pool[poolIdx % pool.length];
      poolIdx += 1;
      a.currentTime = 0;
      a.playbackRate = 0.92 + Math.random() * 0.16;
      // Одинаковые клипы складываются синфазно — громкость падает с числом кубиков.
      a.volume = Math.max(0.12, 0.25 / Math.sqrt(Math.max(1, activeCount)));
      a.play().catch(() => {});
    } catch (err) { /* звук необязателен */ }
  }

  // ---- Вёрстка кубика ----
  const DIE_SVG = '<svg class="dfx-die-svg" viewBox="0 0 100 100" aria-hidden="true">'
    + '<polygon points="50,4 91,27 91,73 50,96 9,73 9,27" fill="var(--dfx-color)" fill-opacity=".92" stroke="rgba(255,255,255,.75)" stroke-width="3" stroke-linejoin="round"/>'
    + '<polygon points="50,18 79,66 21,66" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="2.5" stroke-linejoin="round"/>'
    + '<path d="M50 4V18M91 27L79 66M9 27L21 66M91 73L79 66M9 73L21 66M50 96L21 66M50 96L79 66" stroke="rgba(255,255,255,.35)" stroke-width="2" fill="none"/>'
    + '</svg>';

  function buildItem(entry, size) {
    const item = document.createElement('div');
    item.className = 'dfx-item';
    item.style.setProperty('--dfx-color', entry.color || '#888888');
    item.style.setProperty('--dfx-size', size + 'px');

    const die = document.createElement('div');
    die.className = 'dfx-die';
    die.innerHTML = DIE_SVG;
    const num = document.createElement('div');
    num.className = 'dfx-die-num';
    num.textContent = String(1 + Math.floor(Math.random() * 20));
    die.appendChild(num);

    // Имя бросающего вводит ГМ/игрок — только textContent.
    const chip = document.createElement('div');
    chip.className = 'dfx-chip';
    const name = document.createElement('div');
    name.className = 'dfx-chip-name';
    name.textContent = entry.characterName;
    if (entry.dead) { // бросок убитого персонажа — значок-череп после имени
      const skull = window.Icons.el('skull');
      if (skull) name.append(' ', skull);
    }
    const total = document.createElement('div');
    total.className = 'dfx-chip-total';
    total.textContent = String(entry.total);
    const detail = document.createElement('div');
    detail.className = 'dfx-chip-detail';
    window.renderDiceParts(detail, window.diceChipParts(entry)); // части: числа и иконки (dice.js)
    chip.append(name, total, detail);

    item.append(die, chip);
    return { item, die, num, chip };
  }

  // ---- Жизненный цикл ----
  function dismiss(rec, fadeMs) {
    if (rec.removed) return;
    rec.removed = true;
    rec.timers.forEach(clearTimeout);
    rec.intervals.forEach(clearInterval);
    const idx = active.indexOf(rec);
    if (idx !== -1) active.splice(idx, 1);
    rec.el.style.transition = `opacity ${fadeMs}ms ease`;
    rec.el.style.opacity = '0';
    setTimeout(() => rec.el.remove(), fadeMs + 50);
  }

  function clearAll() {
    active.slice().forEach((rec) => dismiss(rec, EVICT_FADE_MS));
    waiting.length = 0; // отложенные броски прежней сцены тоже не нужны
    retryTimers.forEach(clearTimeout);
    retryTimers.clear();
  }

  // Траектория: влёт с края throw.from → перелёт за точку падения → отскок назад →
  // затухающие покачивания → покой. «Высота» имитируется масштабом кубика.
  function flightKeyframes(entry, tx, ty, W, H, size) {
    const th = throwOf(entry);
    const r = mulberry32(th.seed >>> 0);
    let dx0 = 0;
    let dy0 = 0;
    if (th.from === 0) { dx0 = -(tx + size * 1.5); dy0 = (r() - 0.5) * H * 0.5; }
    else if (th.from === 1) { dx0 = (W - tx) + size * 1.5; dy0 = (r() - 0.5) * H * 0.5; }
    else if (th.from === 2) { dy0 = -(ty + size * 1.5); dx0 = (r() - 0.5) * W * 0.5; }
    else { dy0 = (H - ty) + size * 1.5; dx0 = (r() - 0.5) * W * 0.5; }
    const len = Math.hypot(dx0, dy0) || 1;
    const dirx = -dx0 / len;           // направление движения к точке падения
    const diry = -dy0 / len;
    const overshoot = size * (1.2 + r() * 0.8);
    const spin = (r() < 0.5 ? -1 : 1) * (540 + r() * 360);
    const tilt = (r() - 0.5) * 20;     // небольшой наклон «в покое», чтобы не выглядело штампом
    const finalRot = Math.round(spin / 360) * 360 + tilt;
    const move = [
      { offset: 0, transform: `translate(${dx0}px, ${dy0}px)`, easing: 'cubic-bezier(.15,.55,.3,1)' },
      { offset: 0.55, transform: `translate(${dirx * overshoot}px, ${diry * overshoot}px)`, easing: 'ease-out' },
      { offset: 0.75, transform: `translate(${-dirx * size * 0.35}px, ${-diry * size * 0.35}px)`, easing: 'ease-in-out' },
      { offset: 0.9, transform: `translate(${dirx * size * 0.12}px, ${diry * size * 0.12}px)`, easing: 'ease-in-out' },
      { offset: 1, transform: 'translate(0px, 0px)' },
    ];
    const tumble = [
      { offset: 0, transform: 'rotate(0deg) scale(.7)', easing: 'cubic-bezier(.1,.7,.2,1)' },
      { offset: 0.25, transform: `rotate(${finalRot * 0.55}deg) scale(1.3)`, easing: 'ease-in' },
      { offset: 0.55, transform: `rotate(${finalRot * 0.85}deg) scale(1)`, easing: 'ease-out' },
      { offset: 0.65, transform: `rotate(${finalRot * 0.9}deg) scale(1.15)`, easing: 'ease-in' },
      { offset: 0.75, transform: `rotate(${finalRot * 0.96}deg) scale(1)`, easing: 'ease-out' },
      { offset: 0.85, transform: `rotate(${finalRot * 0.99}deg) scale(1.06)`, easing: 'ease-in' },
      { offset: 1, transform: `rotate(${finalRot}deg) scale(1)` },
    ];
    return { move, tumble, finalRot };
  }

  function land(rec, entry, tx, W) {
    rec.intervals.forEach(clearInterval);
    rec.intervals.length = 0;
    rec.num.textContent = String(entry.die); // на посадке число всегда равно серверному броску
    rec.el.classList.add('dfx-landed');
    if (entry.critical === 'success') rec.el.classList.add('dfx-crit-success');
    else if (entry.critical === 'fail') rec.el.classList.add('dfx-crit-fail');
    if (!(reduceMotion && reduceMotion.matches)) {
      rec.die.animate(
        [{ transform: `${rec.restTransform} scale(1)` }, { transform: `${rec.restTransform} scale(1.25)` }, { transform: `${rec.restTransform} scale(1)` }],
        { duration: 260, easing: 'ease-out' },
      );
    }
    // Чип с итогом не должен вылезать за край экрана (кубик может лечь у границы).
    rec.chip.style.setProperty('--dfx-chip-shift', '0px');
    const rect = rec.chip.getBoundingClientRect();
    const layerRect = layer.getBoundingClientRect();
    let shift = 0;
    if (rect.left < layerRect.left + 6) shift = layerRect.left + 6 - rect.left;
    else if (rect.right > layerRect.right - 6) shift = layerRect.right - 6 - rect.right;
    rec.chip.style.setProperty('--dfx-chip-shift', shift + 'px');
    rec.timers.push(setTimeout(() => dismiss(rec, FADE_MS), REST_MS));
  }

  function spawnDie(entry, delayMs, attempt = 0) {
    const W = layer.clientWidth;
    const H = layer.clientHeight;
    if (!W || !H) {
      // Слой ещё не размечен (окно только что показано/развёрнуто) — не теряем бросок,
      // пробуем чуть позже.
      if (attempt < LAYOUT_RETRIES) {
        const t = setTimeout(() => {
          retryTimers.delete(t);
          spawnDie(entry, delayMs, attempt + 1);
        }, LAYOUT_RETRY_MS);
        retryTimers.add(t);
      }
      return;
    }
    // Лишний кубик вытесняет самый старый.
    while (active.length >= MAX_DICE) dismiss(active[0], EVICT_FADE_MS);
    const size = clamp(Math.min(W, H) * 0.07, 56, 96);
    const th = throwOf(entry);
    const tx = th.x * W;
    const ty = th.y * H;

    const parts = buildItem(entry, size);
    const rec = {
      el: parts.item, die: parts.die, num: parts.num, chip: parts.chip,
      timers: [], intervals: [], removed: false, restTransform: 'rotate(0deg)',
    };
    rec.el.style.left = `${tx - size / 2}px`;
    rec.el.style.top = `${ty - size / 2}px`;
    layer.appendChild(rec.el);
    active.push(rec);

    const start = () => {
      if (rec.removed) return;
      playRollSound(active.length);
      if (reduceMotion && reduceMotion.matches) {
        // Без полёта: кубик просто проявляется на месте.
        rec.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
        land(rec, entry, tx, W);
        return;
      }
      const { move, tumble, finalRot } = flightKeyframes(entry, tx, ty, W, H, size);
      rec.restTransform = `rotate(${finalRot}deg)`;
      rec.el.animate(move, { duration: FLY_MS, fill: 'forwards' });
      rec.die.animate(tumble, { duration: FLY_MS, fill: 'forwards' });
      // Пока кубик летит — число мелькает, как у настоящего кубика.
      rec.intervals.push(setInterval(() => {
        rec.num.textContent = String(1 + Math.floor(Math.random() * 20));
      }, 70));
      rec.timers.push(setTimeout(() => land(rec, entry, tx, W), FLY_MS));
    };

    // Пока ждём старта (если пришло сразу несколько бросков), кубик невидим.
    rec.el.style.visibility = 'hidden';
    const begin = () => {
      rec.el.style.visibility = 'visible';
      start();
    };
    if (delayMs > 0) rec.timers.push(setTimeout(begin, delayMs));
    else begin();
  }

  // Окно/вкладка, которое сейчас не на переднем плане (ГМ и игрок открыты в двух
  // окнах), браузер считает скрытым. Броски, пришедшие в этот момент, не
  // выбрасываем, а откладываем и проигрываем, когда окно снова видно — но только
  // свежие (HIDDEN_REPLAY_MS по времени прихода на клиент, это не зависит от
  // рассинхрона часов между машинами), иначе вернувшийся через час увидел бы
  // «призрачный» кубик давнего броска.
  function flushWaiting() {
    if (document.hidden || !waiting.length) return;
    const now = performance.now();
    const batch = waiting.splice(0).filter((w) => now - w.at <= HIDDEN_REPLAY_MS).slice(-MAX_DICE);
    batch.forEach((w, i) => spawnDie(w.entry, i * 120));
  }
  document.addEventListener('visibilitychange', flushWaiting);

  window.diceFx = {
    // Следующий state применить без проигрывания (после реконнекта).
    skipNext() { skipNextFlag = true; },

    onState(state) {
      if (!state) return;
      const log = state.diceLog || [];
      // Смена локации — кубики прежней сцены убираем.
      if (lastLocationId !== null && state.activeLocationId !== lastLocationId) clearAll();
      lastLocationId = state.activeLocationId;

      if (!initialized || skipNextFlag) {
        // Первый снимок (или после реконнекта) — историю помечаем виденной, не проигрываем.
        seen = new Set(log.map((e) => e.id));
        initialized = true;
        skipNextFlag = false;
        return;
      }
      // Новые записи — те, что идут перед первой уже виденной (лог: новые первыми).
      const fresh = [];
      for (const e of log) {
        if (seen.has(e.id)) break;
        fresh.push(e);
      }
      seen = new Set(log.map((e) => e.id));
      fresh.reverse();
      if (document.hidden) {
        // Фоновое окно: не анимируем «в пустоту», проиграем, когда окно вернётся (flushWaiting).
        const at = performance.now();
        fresh.forEach((e) => waiting.push({ entry: e, at }));
        if (waiting.length > MAX_WAITING) waiting.splice(0, waiting.length - MAX_WAITING);
        return;
      }
      fresh.forEach((e, i) => spawnDie(e, i * 120));
    },
  };
})();
