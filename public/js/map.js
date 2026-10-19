// Цвета и шрифт для canvas читаем из CSS-токенов (public/css/tokens.css), чтобы палитра
// и шрифт менялись в одном месте. Значения здесь — запасные, на случай если CSS не применился.
// Объект мутируется на месте (readTheme), поэтому ссылки на него остаются валидными.
const THEME = {
  font: "'IBM Plex Sans Variable', system-ui, sans-serif",
  bg: '#0b0e13', text: '#e5ebf3', surface: 'rgba(14, 18, 24, 0.92)',
  accent: '#79c6ee', amber: '#e8b04f', danger: '#e5675d', ok: '#5cc48d',
};

// NPC не имеют персональных цветов (их слишком много и они не «постоянные
// герои» партии) — запасной оттенок; на токене цвет задаёт фракция (FACTION_STYLE).
const NPC_COLOR = '#e5675d';

// Фракция NPC (npc.faction — её ставит ГМ в карточке NPC; она уже уходит игрокам в
// публичном state и видна в полосе боя): кольцо токена и значок у имени. У каждой
// фракции своя ФОРМА значка (треугольник / круг / кольцо — те же, что иконки
// faction-* в интерфейсе), поэтому различие читается и без опоры на цвет. Цвета —
// токены --enemy/--ally/--neutral. «Нейтрал» — способ ГМ не раскрывать намерения NPC.
const FACTION_STYLE = {
  enemy: { color: '#e5675d', shape: 'triangle' },
  ally: { color: '#5cc48d', shape: 'circle' },
  neutral: { color: '#9fb0c6', shape: 'ring' },
};
const factionStyleFor = (npc) => FACTION_STYLE[npc && npc.faction] || FACTION_STYLE.neutral;

function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  THEME.font = v('--font-ui', THEME.font);
  THEME.bg = v('--bg', THEME.bg);
  THEME.text = v('--text', THEME.text);
  THEME.surface = v('--surface-0', THEME.surface);
  THEME.accent = v('--accent', THEME.accent);
  THEME.amber = v('--amber', THEME.amber);
  THEME.danger = v('--danger', THEME.danger);
  THEME.ok = v('--ok', THEME.ok);
  FACTION_STYLE.enemy.color = v('--enemy', FACTION_STYLE.enemy.color);
  FACTION_STYLE.ally.color = v('--ally', FACTION_STYLE.ally.color);
  FACTION_STYLE.neutral.color = v('--neutral', FACTION_STYLE.neutral.color);
}
readTheme();

// Значок фракции на canvas (r — «радиус» в мировых px). Контур тёмным — читается на любом фоне.
function drawFactionMarker(ctx, shape, cx, cy, r, color, outline) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (shape === 'triangle') {
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r * 0.95, cy + r * 0.75);
    ctx.lineTo(cx - r * 0.95, cy + r * 0.75);
    ctx.closePath();
  } else {
    ctx.arc(cx, cy, shape === 'ring' ? r * 0.72 : r * 0.9, 0, Math.PI * 2);
  }
  ctx.lineWidth = outline;
  ctx.strokeStyle = 'rgba(10, 11, 15, 0.9)';
  if (shape === 'ring') {
    ctx.lineWidth = r * 0.5 + outline * 2; // подложка кольца
    ctx.stroke();
    ctx.lineWidth = r * 0.5;
    ctx.strokeStyle = color;
    ctx.stroke();
  } else {
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.restore();
}

// Цвет рисования мастера — фиксированный, нейтральный (белый), чтобы визуально
// отличаться от цветов персонажей (см. поле color в characters.json).
const GM_DRAW_COLOR = '#ffffff';

// Кэш загруженных аватаров по URL; при загрузке перерисовываем карту.
const avatarImageCache = new Map();
function getAvatarImage(url, onLoad) {
  if (!url) return null;
  let entry = avatarImageCache.get(url);
  if (!entry) {
    const img = new Image();
    entry = { img, ready: false };
    avatarImageCache.set(url, entry);
    img.onload = () => { entry.ready = true; if (onLoad) onLoad(); };
    img.src = url;
  }
  return entry.ready ? entry.img : null;
}

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 3;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Размер клетки тумана войны в мировых пикселях. Туман не привязан к какому-либо
// прямоугольнику — клетки адресуются абсолютными мировыми индексами (i,j),
// сервер геометрию не знает — только хранит blob-строку (список закрытых клеток).
const FOG_CELL = 24;
const FOG_HATCH_TILE = 8; // делит FOG_CELL нацело (24/8=3) — плитка узора без обрезков
const FOG_FRAME_PAD = FOG_CELL * 4; // запас вокруг картинок/поезда при «Скрыть всё»
const CAMERA_CONTENT_MARGIN = 800;  // запас (мировые px) вокруг содержимого карты, за который камера не уезжает

// Анимация ходьбы токена (чисто клиентская: сервер двигает токен мгновенно,
// путь считается из смены позиции между двумя state — см. syncTokenAnimations).
const WALK_STEP_MS = 120;     // время на одну клетку
const WALK_MAX_MS = 1000;     // потолок на весь путь: на длинных дистанциях шаг короче
const WALK_MAX_STEPS = 40;    // путь длиннее — телепорт ГМ, без анимации
const WALK_BOB_PX = 2;        // высота подпрыгивания токена на шаге (мировые px)
const WALK_FX_MAX = 300;      // предел частиц ходьбы одновременно (старые отбрасываем)
const WALK_DUST_MS = 420;     // жизнь облачка пыли
const WALK_PRINT_MS = 1100;   // жизнь следа

function createMapController({ canvas, role, myCharacterId }) {
  const ctx = canvas.getContext('2d');
  let currentState = null;
  // selectedTarget: null | { type: 'character' | 'npc', id }
  let selectedTarget = role === 'player' && myCharacterId ? { type: 'character', id: myCharacterId } : null;
  let reachableCells = new Map();
  let moveHandler = null;
  let selectHandler = null;
  // Вне боя перемещение свободное — тап не гейтится по reachableCells (см. handleTap).
  let combatActive = false;

  // Камера: x/y — мировая точка (px при zoom=1) в центре экрана; zoom — масштаб.
  const camera = { x: 0, y: 0, zoom: 1.4 };
  let cameraInitialized = false;

  // Персистентность камеры (позиция + зум) в localStorage — ключ разный для
  // ГМ и игрока, чтобы не путать позиции при тестировании обеих ролей в одном
  // браузере. Сохранение debounce'нуто (пан/зум дёргают draw() очень часто),
  // иначе запись в localStorage на каждый pointermove/wheel была бы слишком
  // расточительной.
  // Ключ включает активную локацию — у каждой локации своя независимая
  // сохранённая позиция/зум камеры (см. updateState: сброс при смене локации).
  function cameraStorageKey() {
    return `vanshot:mapCamera:${role}:${currentState?.activeLocationId || 'default'}`;
  }
  let cameraSaveTimer = null;
  function saveCameraDebounced() {
    clearTimeout(cameraSaveTimer);
    cameraSaveTimer = setTimeout(() => {
      try {
        localStorage.setItem(cameraStorageKey(), JSON.stringify({ x: camera.x, y: camera.y, zoom: camera.zoom }));
      } catch (e) { /* localStorage недоступен (приватный режим и т.п.) — не критично */ }
    }, 400);
  }
  function loadSavedCamera() {
    try {
      const raw = localStorage.getItem(cameraStorageKey());
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (typeof saved.x === 'number' && typeof saved.y === 'number' && typeof saved.zoom === 'number') return saved;
    } catch (e) { /* битые данные — работаем как при первом запуске */ }
    return null;
  }
  const activePointers = new Map();
  let dragLast = null;
  let dragStart = null;
  let dragMoved = false;
  let suppressTap = false;
  let panButton = null; // кнопка мыши, начавшая текущий жест панорамирования (null — тач/перо/нет жеста)
  let pinchStartDist = null;
  let pinchStartZoom = null;

  canvas.style.touchAction = 'none';

  // --- Туман войны -------------------------------------------------------
  // Источник правды: Uint8Array(cols*rows), 1 = скрыто/чёрное, 0 = видно.
  // По умолчанию всё 0 ⇒ карта видна целиком, ГМ сам закрашивает зоны.
  let fogSet = new Set();      // абсолютные мировые клетки тумана ("i,j" → скрыта), без привязки к рамке
  let fogEdit = false;
  let fogTool = 'brush';       // 'brush' | 'zone'
  let fogHide = true;          // true = скрыть (красим чёрным), false = открыть
  let fogBrush = 2;            // радиус кисти в клетках тумана
  let fogSelection = null;     // { x0,y0,x1,y1 } мировой прямоугольник при зоне
  let fogPainting = false;
  let fogChangeHandler = null;

  // --- Картинки на карте (только ГМ двигает/масштабирует) ----------------
  let imageEdit = false;               // режим редактирования — как fogEdit, перехватывает поинтер целиком
  let selectedMapImageId = null;
  let mapImageSelectHandler = null;
  let mapImageUpdateHandler = null;    // вызывается по окончании перетаскивания
  let imageDragging = null;            // { id, offsetX, offsetY } — offset от центра картинки до точки захвата
  let imageResizing = null;            // { id, anchorX, anchorY, dirX, dirY, length0, naturalWidth, naturalHeight, scale0 }
  let imageRotating = null;            // { id, rotation0, startAngle } — rotation0/startAngle в радианах
  const IMAGE_HANDLE_RADIUS = 9;       // в экранных px — переводим в мировые через camera.zoom
  const ROTATE_HANDLE_DIST = 26;       // в экранных px — расстояние от верхней грани до ручки поворота
  const TOUCH_HANDLE_FACTOR = 2.2;     // у пальца ручки целиться труднее — зона попадания больше, чем у мыши
  let lastPointerType = 'mouse';       // тип последнего указателя (для зоны попадания по ручкам)

  // Править картинку может ГМ — любую; игрок — только свою (m.ownerId — characterId
  // автора, его проставляет сервер при «Принять» ГМ). Блокировку 🔒 (m.locked) учитывают
  // искатели ручек ниже, а сервер проверяет и владение, и блокировку сам.
  const canEditImage = (m) => !!m && (role === 'gm' || (!!myCharacterId && m.ownerId === myCharacterId));
  // Режим правки картинок активен: у ГМ — всегда при imageEdit, у игрока — только после входа.
  const imageEditActive = () => imageEdit && (role === 'gm' || !!myCharacterId);
  const handleHitRadius = () => (IMAGE_HANDLE_RADIUS * (lastPointerType === 'mouse' ? 1 : TOUCH_HANDLE_FACTOR)) / camera.zoom;

  // Топовая (последняя в массиве) картинка под мировой точкой, или null.
  // Точка переводится в локальные (неповёрнутые) координаты картинки поворотом
  // на -rotation вокруг центра — дальше обычная проверка axis-aligned прямоугольника.
  function findMapImageAt(wx, wy) {
    if (!currentState || !currentState.mapImages) return null;
    const list = currentState.mapImages;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      // Игрок «видит сквозь» чужие и ГМ-картинки: выбрать можно только свою,
      // иначе ГМ-фон под ней перехватывал бы клик.
      if (!canEditImage(m)) continue;
      const w = m.naturalWidth * m.scale;
      const h = m.naturalHeight * m.scale;
      const angle = m.rotation || 0;
      const dx = wx - m.x;
      const dy = wy - m.y;
      const cos = Math.cos(-angle);
      const sin = Math.sin(-angle);
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      if (lx >= -w / 2 && lx <= w / 2 && ly >= -h / 2 && ly <= h / 2) return m;
    }
    return null;
  }

  // Четыре угла картинки в мировых координатах (с учётом поворота): [x, y] для NW/NE/SE/SW.
  function mapImageCorners(m) {
    const w = m.naturalWidth * m.scale;
    const h = m.naturalHeight * m.scale;
    const angle = m.rotation || 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const local = [
      { x: -w / 2, y: -h / 2 },
      { x: w / 2, y: -h / 2 },
      { x: w / 2, y: h / 2 },
      { x: -w / 2, y: h / 2 },
    ];
    return local.map((p) => ({
      x: m.x + p.x * cos - p.y * sin,
      y: m.y + p.x * sin + p.y * cos,
    }));
  }

  // Мировая позиция ручки поворота — над верхней гранью картинки, с учётом поворота.
  function rotateHandlePosition(m) {
    const h = m.naturalHeight * m.scale;
    const angle = m.rotation || 0;
    const dist = h / 2 + ROTATE_HANDLE_DIST / camera.zoom;
    return {
      x: m.x + Math.sin(angle) * dist,
      y: m.y - Math.cos(angle) * dist,
    };
  }

  // Ручка поворота выбранной картинки под мировой точкой, или null.
  function findRotateHandleAt(wx, wy) {
    if (!currentState || !currentState.mapImages || !selectedMapImageId) return null;
    const m = currentState.mapImages.find((mi) => mi.id === selectedMapImageId);
    if (!m || m.locked || !canEditImage(m)) return null;
    const p = rotateHandlePosition(m);
    const radius = handleHitRadius();
    return Math.hypot(wx - p.x, wy - p.y) <= radius ? m : null;
  }

  // Угловая ручка выбранной картинки под мировой точкой (для масштабирования
  // перетаскиванием) — проверяется только у уже выбранной картинки.
  function findMapImageHandleAt(wx, wy) {
    if (!currentState || !currentState.mapImages || !selectedMapImageId) return null;
    const m = currentState.mapImages.find((mi) => mi.id === selectedMapImageId);
    if (!m || m.locked || !canEditImage(m)) return null;
    const corners = mapImageCorners(m);
    const radius = handleHitRadius();
    for (let i = 0; i < corners.length; i++) {
      if (Math.hypot(wx - corners[i].x, wy - corners[i].y) <= radius) {
        return { m, cornerIndex: i, corners };
      }
    }
    return null;
  }

  // --- Рисование (панель рисования) ---------------------------------------
  // drawMode — как fogEdit/imageEdit, перехватывает жест целиком, но доступен
  // ОБЕИМ ролям (не только ГМ). Цвет фиксирован на клиента: у ГМ — белый,
  // у игрока — цвет его персонажа (поле color в characters.json, приходит
  // с state), сервер не доверяет цвету от клиента и определяет его сам по
  // authorId (см. gameState.js). До первого state цвет неизвестен — берём
  // тот же дефолт, что и раньше, и обновляем в updateState().
  let drawMode = false;
  let drawTool = 'pen';            // 'pen' | 'eraser'
  let drawWidth = 4;               // толщина линии в мировых px
  const myAuthorId = role === 'gm' ? 'gm' : myCharacterId;
  let drawColor = role === 'gm' ? GM_DRAW_COLOR : '#ffffff';
  let currentStroke = null;        // { points: [...] } — черновик, пока пойнтер зажат
  let drawErasing = false;         // true — идёт жест ластика (может задеть несколько штрихов)
  let erasedThisGesture = null;    // Set<id> — не слать повторный erase за один жест
  let drawAddHandler = null;
  let drawEraseHandler = null;
  let drawUndoHandler = null;      // вызывается по клику ПКМ (без движения) в режиме рисования

  // --- Спецэффекты (дым/огонь/фейерверк) -----------------------------------
  // vfxPlaceMode — как drawMode, доступен ОБЕИМ ролям, но НЕ гасится после
  // одного клика (можно поставить несколько эффектов подряд) — выключается
  // повторным нажатием той же кнопки в EffectsPanel.vue.
  let vfxPlaceMode = null;   // null | 'smoke' | 'fire' | 'firework' | 'explosion' | 'lightning' | 'magic'
  let vfxPlaceHandler = null;
  let activeEffects = [];    // [{ type, x, y, startedAt, duration }] — только в памяти, не персистится
  let animRafId = null;      // единый rAF-цикл: спецэффекты + ходьба токенов + частицы ходьбы
  const VFX_DURATION = { smoke: 2200, fire: 1800, firework: 1200, explosion: 1100, lightning: 600, magic: 2000 };

  // --- Линейка --------------------------------------------------------------
  // Меряет расстояние между двумя клетками (жест: нажать — тянуть — отпустить), доступна
  // обеим ролям. Чисто локальная: ничего не шлётся на сервер и другим участникам. Линия
  // остаётся после отпускания — до следующего нажатия, выключения режима или смены
  // локации. «Ход» — манхэттен (стоимость хода в бою, как считает сервер), «Прямая» —
  // евклидово расстояние в клетках.
  let rulerMode = false;
  let ruler = null;              // { a: {x, y}, b: {x, y} } — клетки (целые)
  let rulerDragging = false;
  let rulerChangeHandler = null; // fn({ moves, straight } | null) — показания для RulerPanel.vue

  function rulerReading() {
    if (!ruler) return null;
    const dx = Math.abs(ruler.a.x - ruler.b.x);
    const dy = Math.abs(ruler.a.y - ruler.b.y);
    return { moves: dx + dy, straight: Math.round(Math.hypot(dx, dy) * 10) / 10 };
  }
  function notifyRuler() {
    if (rulerChangeHandler) rulerChangeHandler(rulerReading());
  }
  function clearRuler() {
    ruler = null;
    rulerDragging = false;
    notifyRuler();
    draw();
  }

  // --- Ходьба токенов ------------------------------------------------------
  // Ключи с префиксом ('c:'+id / 'n:'+id): id персонажей и NPC в коде не
  // гарантированно уникальны между собой.
  const tokenKey = (type, id) => (type === 'npc' ? 'n:' : 'c:') + id;
  // Логические позиции токенов из ПРОШЛОГО state. Пересобирается целиком на
  // каждый updateState (не накапливается) — иначе NPC, пропавший и вернувшийся,
  // получил бы анимацию из старой клетки.
  const lastLogical = new Map();      // key -> { x, y }
  const tokenAnims = new Map();       // key -> { path: [{x,y}], cum: [число клеток от старта], total, startedAt, stepMs }
  let walkFx = [];                    // [{ kind: 'dust'|'print', x, y, startedAt, duration, seed, angle, side, ownerKey, isNpc, faint }]
  let skipNextAnim = false;           // следующий state применить без анимации (реконнект)
  const reduceMotionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  // Детерминированный псевдослучайный сдвиг по seed — частицы должны быть
  // стабильны между кадрами (позиция считается заново каждый draw() из t,
  // а не хранится), иначе при true Math.random() они бы «дёргались».
  function prand(seed) {
    const x = Math.sin(seed * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  function playEffect(type, x, y) {
    const duration = VFX_DURATION[type] || 1500;
    activeEffects.push({ type, x, y, startedAt: performance.now(), duration });
    startAnimLoop();
  }

  // Единый цикл анимации: сначала убираем истёкшее (эффекты, частицы ходьбы,
  // завершённые твины токенов), потом draw() — финальный кадр сам покажет
  // токены на логических позициях без «щелчка». Один rAF на всё, иначе
  // совпавшие эффект и ходьба давали бы два draw() за кадр. Когда анимировать
  // нечего — цикл останавливается и CPU не жжёт.
  function animLoop() {
    const now = performance.now();
    activeEffects = activeEffects.filter((fx) => now - fx.startedAt < fx.duration);
    walkFx = walkFx.filter((fx) => now < fx.startedAt + fx.duration);
    tokenAnims.forEach((a, key) => {
      if (now - a.startedAt >= a.total * a.stepMs) tokenAnims.delete(key);
    });
    draw();
    animRafId = (activeEffects.length || walkFx.length || tokenAnims.size)
      ? requestAnimationFrame(animLoop)
      : null;
  }

  function startAnimLoop() {
    if (animRafId === null) animLoop();
  }

  // 4-связная «растеризованная линия» (walk_grid): длина пути = манхэттенскому
  // расстоянию (стоимость хода в бою) и детерминирована от (from, to) — у ГМ и
  // всех игроков маршрут одинаковый без синхронизации по сети.
  function buildStepPath(from, to) {
    const path = [{ x: from.x, y: from.y }];
    const nx = Math.abs(to.x - from.x);
    const ny = Math.abs(to.y - from.y);
    const sx = Math.sign(to.x - from.x);
    const sy = Math.sign(to.y - from.y);
    let x = from.x;
    let y = from.y;
    for (let ix = 0, iy = 0; ix < nx || iy < ny;) {
      if ((0.5 + ix) / nx < (0.5 + iy) / ny) { x += sx; ix++; } else { y += sy; iy++; }
      path.push({ x, y });
    }
    return path;
  }

  // Текущая отображаемая поза токена: позиция в клетках (дробная) и высота
  // подпрыгивания. Нет анимации — логическая позиция.
  function getTokenPose(key, position, now) {
    const a = tokenAnims.get(key);
    if (!a) return { x: position.x, y: position.y, lift: 0 };
    const dist = (now - a.startedAt) / a.stepMs;
    if (dist >= a.total) return { x: position.x, y: position.y, lift: 0 };
    let i = 1;
    while (i < a.cum.length - 1 && a.cum[i] <= dist) i++;
    const segLen = a.cum[i] - a.cum[i - 1];
    const t = segLen > 0 ? clamp((dist - a.cum[i - 1]) / segLen, 0, 1) : 1;
    const p0 = a.path[i - 1];
    const p1 = a.path[i];
    return {
      x: p0.x + (p1.x - p0.x) * t,
      y: p0.y + (p1.y - p0.y) * t,
      lift: Math.sin(Math.PI * (dist - Math.floor(dist))) * WALK_BOB_PX,
    };
  }

  // Запускает анимацию ходьбы токена from -> to. Если токен уже идёт, новый
  // путь стартует с его текущей отображаемой позиции (без скачка).
  function startTokenAnim(key, isNpc, faint, from, to, now) {
    const cellSize = currentState.map.cellSize;
    const running = tokenAnims.get(key);
    const runningDist = running ? (now - running.startedAt) / running.stepMs : Infinity;
    let path;
    if (running && runningDist < running.total) {
      // Токен дойдёт до ближайшей впереди точки решётки (без разворота на
      // месте), дальше — новый путь к цели: ломаная остаётся осевой, скачка нет.
      const pose = getTokenPose(key, from, now);
      let i = 1;
      while (i < running.cum.length - 1 && running.cum[i] <= runningDist) i++;
      path = [{ x: pose.x, y: pose.y }, ...buildStepPath(running.path[i], to)];
      // Ещё не начавшиеся частицы старого маршрута больше не нужны.
      walkFx = walkFx.filter((fx) => fx.ownerKey !== key || fx.startedAt <= now);
    } else {
      path = buildStepPath(from, to);
    }
    // Длина сегментов в клетках; шаги по решётке ровно по 1, первый дробный может быть короче.
    const cum = [0];
    for (let i = 1; i < path.length; i++) {
      cum.push(cum[i - 1] + Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y));
    }
    const total = cum[cum.length - 1];
    if (total <= 0) { tokenAnims.delete(key); return; }
    if (total > WALK_MAX_STEPS) { tokenAnims.delete(key); return; } // телепорт — мгновенно
    const stepMs = Math.min(WALK_STEP_MS, WALK_MAX_MS / total);
    tokenAnims.set(key, { path, cum, total, startedAt: now, stepMs });

    // Частицы заранее, с будущим startedAt (как delay у дыма): пыль и след в
    // клетке, которую токен покидает, в момент отрыва ноги.
    const seedBase = now + (isNpc ? 11 : 3);
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (dx === 0 && dy === 0) continue;
      const angle = Math.atan2(dy, dx);
      const startedAt = now + (cum[i] + 0.25) * stepMs;
      const fx = { x: (a.x + 0.5) * cellSize, y: (a.y + 0.5) * cellSize + 20, startedAt, seed: seedBase + i * 17, angle, ownerKey: key, isNpc, faint };
      walkFx.push({ ...fx, kind: 'dust', duration: WALK_DUST_MS });
      walkFx.push({ ...fx, kind: 'print', duration: WALK_PRINT_MS, side: i % 2 === 0 ? 1 : -1 });
    }
    if (walkFx.length > WALK_FX_MAX) walkFx = walkFx.slice(walkFx.length - WALK_FX_MAX);
  }

  // Сравнивает позиции токенов с прошлым state и запускает анимацию для
  // сместившихся. skip — применить без анимации (первый state, смена локации,
  // фоновая вкладка, reduced-motion, реконнект).
  function syncTokenAnimations(state, skip) {
    const now = performance.now();
    const next = new Map();
    const consider = (key, entity, isNpc) => {
      if (!entity.position) return;
      const to = { x: entity.position.x, y: entity.position.y };
      next.set(key, to);
      const from = lastLogical.get(key);
      if (!from || (from.x === to.x && from.y === to.y)) return;
      if (skip || entity.dead) { tokenAnims.delete(key); return; }
      startTokenAnim(key, isNpc, role === 'gm' && isNpc && !entity.visible, from, to, now);
    };
    (state.characters || []).forEach((c) => consider(tokenKey('character', c.id), c, false));
    (state.npcs || [])
      .filter((n) => n.locationId === state.activeLocationId)
      .forEach((n) => consider(tokenKey('npc', n.id), n, true));
    lastLogical.clear();
    next.forEach((pos, key) => lastLogical.set(key, pos));
    if (skip) { tokenAnims.clear(); walkFx = []; }
  }

  // Вкладка ушла в фон — rAF там замирает; не копим анимации, а завершаем их,
  // чтобы по возвращении токены стояли на своих клетках.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { tokenAnims.clear(); walkFx = []; }
  });

  function drawSmoke(fx, t) {
    const n = 6;
    for (let i = 0; i < n; i++) {
      const seed = fx.startedAt + i * 97;
      const delay = (i / n) * 0.3;
      const pt = (t - delay) / (1 - delay);
      if (pt <= 0) continue;
      const rx = (prand(seed) - 0.5) * 10;
      const speed = 14 + prand(seed + 1) * 8;
      const px = fx.x + rx * pt;
      const py = fx.y - pt * speed - i * 1.5;
      const r = 4 + pt * 10;
      ctx.beginPath();
      ctx.fillStyle = `rgba(180,180,180,${(1 - pt) * 0.5})`;
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawFire(fx, t, now) {
    const n = 5;
    const fade = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
    for (let i = 0; i < n; i++) {
      const seed = fx.startedAt + i * 53;
      const flick = Math.sin(now / 90 + seed) * 2;
      const bx = fx.x + (prand(seed) - 0.5) * 8 + flick;
      const h = (14 + prand(seed + 1) * 10 + Math.sin(now / 70 + seed) * 3) * Math.min(1, t * 4);
      const grad = ctx.createRadialGradient(bx, fx.y, 0, bx, fx.y, Math.max(1, h));
      grad.addColorStop(0, `rgba(255,240,150,${0.9 * fade})`);
      grad.addColorStop(0.5, `rgba(255,140,30,${0.7 * fade})`);
      grad.addColorStop(1, 'rgba(200,40,20,0)');
      ctx.beginPath();
      ctx.fillStyle = grad;
      ctx.ellipse(bx, fx.y - h / 2, Math.max(1, h * 0.35), Math.max(1, h * 0.6), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawFirework(fx, t) {
    const n = 16;
    const R = 40;
    const dist = R * (1 - Math.pow(1 - t, 3)); // ease-out
    const alpha = 1 - t;
    for (let i = 0; i < n; i++) {
      const seed = fx.startedAt + i * 7;
      const angle = (i / n) * Math.PI * 2 + prand(seed) * 0.3;
      const px = fx.x + Math.cos(angle) * dist;
      const py = fx.y + Math.sin(angle) * dist;
      const hue = 20 + Math.floor(prand(seed) * 60);
      ctx.beginPath();
      ctx.fillStyle = `hsla(${hue}, 90%, 60%, ${alpha})`;
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Новые эффекты меняют глобальные стили канваса (lineDash, composite,
  // трансформ) — поэтому, в отличие от дыма/огня/фейерверка выше, каждый
  // обёрнут в save()/restore(), иначе стиль утечёт в слои тумана и токенов.

  // Взрыв: вспышка → ударная волна → осколки → тёмный дым.
  function drawExplosion(fx, t) {
    ctx.save();
    const flashT = Math.min(1, t / 0.35);
    if (flashT < 1) {
      const r = 10 + flashT * 34;
      const grad = ctx.createRadialGradient(fx.x, fx.y, 0, fx.x, fx.y, r);
      grad.addColorStop(0, `rgba(255,255,230,${(1 - flashT) * 0.95})`);
      grad.addColorStop(0.45, `rgba(255,170,40,${(1 - flashT) * 0.8})`);
      grad.addColorStop(1, 'rgba(200,50,10,0)');
      ctx.beginPath();
      ctx.fillStyle = grad;
      ctx.arc(fx.x, fx.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    const ease = 1 - Math.pow(1 - t, 3); // ease-out
    ctx.beginPath();
    ctx.strokeStyle = `rgba(255,210,140,${(1 - t) * 0.8})`;
    ctx.lineWidth = Math.max(0.5, 4 * (1 - t));
    ctx.arc(fx.x, fx.y, 6 + ease * 48, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 12; i++) {
      const seed = fx.startedAt + i * 31;
      const angle = prand(seed) * Math.PI * 2;
      const dist = (28 + prand(seed + 1) * 26) * ease;
      const size = (1.5 + prand(seed + 2) * 1.5) * (1 - t * 0.5);
      ctx.beginPath();
      ctx.fillStyle = `rgba(255,${120 + Math.floor(prand(seed + 3) * 100)},40,${1 - t})`;
      ctx.arc(fx.x + Math.cos(angle) * dist, fx.y + Math.sin(angle) * dist, size, 0, Math.PI * 2);
      ctx.fill();
    }
    if (t > 0.3) {
      const pt = (t - 0.3) / 0.7;
      ctx.beginPath();
      ctx.fillStyle = `rgba(60,60,60,${(1 - pt) * 0.45})`;
      ctx.arc(fx.x, fx.y - pt * 18, 8 + pt * 14, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Молния: три коротких вспышки, у каждой своя форма разряда (сид от номера
  // вспышки, внутри вспышки форма стабильна), в конце — свечение в точке удара.
  function drawLightning(fx, t) {
    const windows = [[0, 0.14], [0.22, 0.4], [0.5, 0.62]];
    const wi = windows.findIndex(([a, b]) => t >= a && t <= b);
    if (wi === -1) return;
    const alpha = 1 - t * 0.5;
    const seedBase = fx.startedAt + wi * 131;
    const height = 130;
    const segs = 12;
    const bolt = [];
    for (let i = 0; i <= segs; i++) {
      const k = i / segs;
      const jitter = i === segs ? 0 : (prand(seedBase + i) - 0.5) * 22 * (1 - k * 0.3);
      bolt.push({ x: fx.x + (1 - k) * 20 + jitter, y: fx.y - height * (1 - k) });
    }
    // Ответвление от середины разряда — короткая ломаная в сторону.
    const branch = [];
    const from = bolt[6];
    const dir = prand(seedBase + 50) < 0.5 ? -1 : 1;
    for (let i = 0; i <= 4; i++) {
      branch.push({
        x: from.x + dir * i * 7 + (prand(seedBase + 60 + i) - 0.5) * 8,
        y: from.y + i * 9,
      });
    }
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(fx.x, fx.y, 0, fx.x, fx.y, 26);
    glow.addColorStop(0, `rgba(200,225,255,${0.8 * alpha})`);
    glow.addColorStop(1, 'rgba(120,170,255,0)');
    ctx.beginPath();
    ctx.fillStyle = glow;
    ctx.arc(fx.x, fx.y, 26, 0, Math.PI * 2);
    ctx.fill();
    [[bolt, 1], [branch, 0.6]].forEach(([pts, k]) => {
      [[`rgba(120,170,255,${0.45 * alpha})`, 7 * k], [`rgba(255,255,255,${0.95 * alpha})`, 2.2 * k]].forEach(([color, width]) => {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.stroke();
      });
    });
    ctx.restore();
  }

  // Магия: вращающиеся рунные кольца + светящиеся искры, поднимающиеся вверх.
  function drawMagic(fx, t) {
    const env = Math.sin(Math.PI * t); // нарастание и затухание: 0 → 1 → 0
    const R = 14 + 20 * Math.min(1, t * 3);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(fx.x, fx.y, 0, fx.x, fx.y, R);
    glow.addColorStop(0, `rgba(180,140,255,${env * 0.45})`);
    glow.addColorStop(1, 'rgba(120,200,255,0)');
    ctx.beginPath();
    ctx.fillStyle = glow;
    ctx.arc(fx.x, fx.y, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(fx.x, fx.y);
    ctx.rotate(t * Math.PI * 2);
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = `rgba(190,140,255,${env * 0.9})`;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.rotate(-t * Math.PI * 4);
    ctx.setLineDash([2, 5]);
    ctx.strokeStyle = `rgba(120,200,255,${env * 0.8})`;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    for (let i = 0; i < 14; i++) {
      const seed = fx.startedAt + i * 41;
      const angle = prand(seed) * Math.PI * 2;
      const rad = (0.3 + 0.7 * prand(seed + 1)) * R;
      const pt = (t * 1.4 + prand(seed + 2)) % 1; // у каждой искры своя фаза подъёма
      const px = fx.x + Math.cos(angle) * rad + Math.sin(pt * 6 + seed) * 3;
      const py = fx.y + Math.sin(angle) * rad * 0.6 - pt * 32;
      ctx.beginPath();
      ctx.fillStyle = `hsla(${200 + Math.floor(prand(seed + 3) * 100)}, 90%, 70%, ${Math.sin(Math.PI * pt) * env})`;
      ctx.arc(px, py, 1.2 + prand(seed + 4) * 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Рисует все активные эффекты — вызывается внутри draw(), см. комментарий
  // там про порядок слоёв (под туманом, но над картинками/сеткой/reachable).
  function drawEffects() {
    if (!activeEffects.length) return;
    const now = performance.now();
    activeEffects.forEach((fx) => {
      const t = Math.min(1, (now - fx.startedAt) / fx.duration);
      if (fx.type === 'smoke') drawSmoke(fx, t);
      else if (fx.type === 'fire') drawFire(fx, t, now);
      else if (fx.type === 'firework') drawFirework(fx, t);
      else if (fx.type === 'explosion') drawExplosion(fx, t);
      else if (fx.type === 'lightning') drawLightning(fx, t);
      else if (fx.type === 'magic') drawMagic(fx, t);
    });
  }

  // Следы ходьбы (пыль и отпечатки) — слой ВЫШЕ тумана и ниже токенов: токены
  // видны поверх тумана, значит и их следы. Положение частицы считается заново
  // из t на каждый кадр (prand(seed) стабильна между кадрами, как у
  // спецэффектов выше). Игроку частицы NPC в тумане не рисуем — иначе следы
  // выдали бы скрытого NPC; у ГМ следы скрытого NPC приглушены (faint), как и сам токен.
  function drawWalkFx() {
    if (!walkFx.length) return;
    const now = performance.now();
    walkFx.forEach((fx) => {
      if (now < fx.startedAt) return; // момент шага ещё не наступил
      if (role === 'player' && fx.isNpc && isPositionFogged(fx.x, fx.y)) return;
      const t = Math.min(1, (now - fx.startedAt) / fx.duration);
      const k = fx.faint ? 0.45 : 1;
      ctx.save();
      if (fx.kind === 'dust') {
        // Два облачка: сносит назад против хода, растут и тают.
        const back = fx.angle + Math.PI;
        for (let j = 0; j < 2; j++) {
          const s = fx.seed + j * 5;
          const drift = (2 + prand(s) * 3) * t;
          const spread = (prand(s + 1) - 0.5) * 4 * t;
          const px = fx.x + Math.cos(back) * drift - Math.sin(back) * spread;
          const py = fx.y + Math.sin(back) * drift + Math.cos(back) * spread - t * 2;
          // Облачко сносит от точки рождения — туман проверяем и по его нынешней позиции.
          if (role === 'player' && fx.isNpc && isPositionFogged(px, py)) continue;
          ctx.globalAlpha = (1 - t) * 0.35 * k;
          ctx.fillStyle = 'rgb(200,192,176)';
          ctx.beginPath();
          ctx.arc(px, py, 1.2 + t * 2.3, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        // След: светлый отпечаток с тонкой тёмной обводкой — читается и на
        // тёмном, и на светлом фоне; левая/правая нога смещены вбок от курса.
        const side = Math.PI / 2;
        const px = fx.x + Math.cos(fx.angle + side) * 2.2 * fx.side;
        const py = fx.y + Math.sin(fx.angle + side) * 2.2 * fx.side;
        if (role === 'player' && fx.isNpc && isPositionFogged(px, py)) { ctx.restore(); return; }
        ctx.translate(px, py);
        ctx.rotate(fx.angle);
        ctx.globalAlpha = Math.min(1, (1 - t) * 2) * 0.5 * k; // первая половина жизни — без затухания
        ctx.fillStyle = 'rgb(235,230,215)';
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.ellipse(0, 0, 2.2, 1.4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    });
  }

  // Расстояние от точки до отрезка — для попадания ластиком по штриху.
  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
    t = clamp(t, 0, 1);
    const cx = x1 + t * dx;
    const cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  // Топовый (последний в массиве) СВОЙ штрих под мировой точкой — ластик
  // стирает только штрихи текущего автора, чужие игнорируются (см. TODO.md).
  function findDrawingAt(wx, wy) {
    if (!currentState || !currentState.drawings) return null;
    const list = currentState.drawings;
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      if (d.authorId !== myAuthorId) continue;
      const threshold = Math.max(6, d.width / 2 + 4);
      if (d.points.length === 1) {
        if (Math.hypot(wx - d.points[0].x, wy - d.points[0].y) <= threshold) return d;
        continue;
      }
      for (let j = 0; j < d.points.length - 1; j++) {
        const p1 = d.points[j];
        const p2 = d.points[j + 1];
        if (distToSegment(wx, wy, p1.x, p1.y, p2.x, p2.y) <= threshold) return d;
      }
    }
    return null;
  }

  function eraseAt(wx, wy) {
    const hit = findDrawingAt(wx, wy);
    if (hit && !erasedThisGesture.has(hit.id)) {
      erasedThisGesture.add(hit.id);
      if (drawEraseHandler) drawEraseHandler(hit.id);
    }
  }

  // Прямоугольник всех комнат карты в мировых координатах (или null, пока
  // состояние карты ещё не пришло). Нет отдельной фоновой картинки — движок
  // не навязывает свой фон, мастер накладывает свои картинки через mapImages.
  function getRoomsWorldBounds() {
    if (!currentState || !currentState.map) return null;
    const { cellSize, gridWidth, gridHeight } = currentState.map;
    return { drawX: 0, drawY: 20, drawWidth: gridWidth * cellSize, drawHeight: gridHeight * cellSize };
  }

  // Прямоугольник «известной карты» (все комнаты + картинки мастера, с запасом) —
  // используется только кнопкой «Скрыть всё», чтобы одним нажатием затянуть
  // туманом всё видимое игрокам содержимое. Сам туман при этом НЕ привязан
  // к этому прямоугольнику — кистью/зоной можно закрасить любую точку карты.
  function getKnownMapBounds() {
    const t = getRoomsWorldBounds();
    if (!t) return null;
    let minX = t.drawX, minY = t.drawY, maxX = t.drawX + t.drawWidth, maxY = t.drawY + t.drawHeight;
    (currentState && currentState.mapImages || []).forEach((m) => {
      const w = m.naturalWidth * m.scale;
      const h = m.naturalHeight * m.scale;
      minX = Math.min(minX, m.x - w / 2);
      minY = Math.min(minY, m.y - h / 2);
      maxX = Math.max(maxX, m.x + w / 2);
      maxY = Math.max(maxY, m.y + h / 2);
    });
    return {
      drawX: minX - FOG_FRAME_PAD,
      drawY: minY - FOG_FRAME_PAD,
      drawWidth: (maxX - minX) + FOG_FRAME_PAD * 2,
      drawHeight: (maxY - minY) + FOG_FRAME_PAD * 2,
    };
  }

  // Плитка-паттерн диагональной штриховки для тумана на экране ГМ (кешируется
  // один раз — не зависит от конкретного состояния тумана).
  let fogHatchPattern = null;
  function getFogHatchPattern(ctx) {
    if (fogHatchPattern) return fogHatchPattern;
    const tile = document.createElement('canvas');
    tile.width = FOG_HATCH_TILE;
    tile.height = FOG_HATCH_TILE;
    const tctx = tile.getContext('2d');
    tctx.strokeStyle = 'rgba(255,255,255,0.2)';
    tctx.lineWidth = 1;
    tctx.beginPath();
    tctx.moveTo(0, FOG_HATCH_TILE);
    tctx.lineTo(FOG_HATCH_TILE, 0);
    tctx.moveTo(-FOG_HATCH_TILE / 2, FOG_HATCH_TILE / 2);
    tctx.lineTo(FOG_HATCH_TILE / 2, -FOG_HATCH_TILE / 2);
    tctx.moveTo(FOG_HATCH_TILE / 2, FOG_HATCH_TILE * 1.5);
    tctx.lineTo(FOG_HATCH_TILE * 1.5, FOG_HATCH_TILE / 2);
    tctx.stroke();
    fogHatchPattern = ctx.createPattern(tile, 'repeat');
    return fogHatchPattern;
  }

  // Клетка тумана по мировым координатам — абсолютная, без привязки к рамке.
  function worldToFogCell(wx, wy) {
    return { i: Math.floor(wx / FOG_CELL), j: Math.floor(wy / FOG_CELL) };
  }

  // Заливает все клетки тумана внутри мирового прямоугольника (используется
  // только «Скрыть всё» — см. getKnownMapBounds).
  function fillFogRect(rect) {
    const i0 = Math.floor(rect.drawX / FOG_CELL);
    const j0 = Math.floor(rect.drawY / FOG_CELL);
    const i1 = Math.floor((rect.drawX + rect.drawWidth) / FOG_CELL);
    const j1 = Math.floor((rect.drawY + rect.drawHeight) / FOG_CELL);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) fogSet.add(i + ',' + j);
    }
  }

  // Едва заметная фоновая сетка клеток — видна и ГМ, и игрокам: помогает
  // на глаз оценить расстояние в клетках и подгонять картинки под сетку.
  // Сетка бесконечная; число линий ограничено видимым вьюпортом, так что
  // тысячи линий не рисуются даже при сильном отдалении.
  const GRID_COLOR = 'rgba(255,255,255,0.1)';
  function drawGrid() {
    if (!currentState || !currentState.map) return;
    // Сетка бесконечная — рисуем линии по всему видимому окну (а не только
    // в пределах gridWidth×gridHeight), число линий ограничено вьюпортом.
    const { cellSize } = currentState.map;
    const viewMin = screenToWorld(0, 0);
    const viewMax = screenToWorld(canvas.width, canvas.height);
    const yOff = 20;
    const i0 = Math.floor(viewMin.x / cellSize) - 1;
    const i1 = Math.ceil(viewMax.x / cellSize) + 1;
    const j0 = Math.floor((viewMin.y - yOff) / cellSize) - 1;
    const j1 = Math.ceil((viewMax.y - yOff) / cellSize) + 1;
    ctx.save();
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1 / camera.zoom; // толщина линии не меняется от зума
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const x = i * cellSize;
      ctx.moveTo(x, j0 * cellSize + yOff);
      ctx.lineTo(x, j1 * cellSize + yOff);
    }
    for (let j = j0; j <= j1; j++) {
      const y = j * cellSize + yOff;
      ctx.moveTo(i0 * cellSize, y);
      ctx.lineTo(i1 * cellSize, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function getFogBlob() {
    // Всегда возвращаем валидную строку (даже пустой массив '[]'), а не null —
    // setFog() на сервере (typeof blob !== 'string') молча отбрасывает null,
    // из-за чего "Открыть все" не персистилось и туман возвращался после
    // перезагрузки страницы.
    return JSON.stringify(Array.from(fogSet));
  }

  function applyFogBlob(blob) {
    fogSet.clear();
    if (blob) {
      try {
        const arr = JSON.parse(blob);
        if (Array.isArray(arr)) arr.forEach((key) => fogSet.add(key));
      } catch (e) {
        // Старый формат («colsxrows:base64») больше не поддерживается — просто сбрасываем туман.
      }
    }
    draw();
  }

  // Проверяет, скрыта ли мировая точка текущим туманом (для игрока).
  function isPositionFogged(wx, wy) {
    if (!fogSet.size) return false;
    const cell = worldToFogCell(wx, wy);
    return fogSet.has(cell.i + ',' + cell.j);
  }

  function paintBrushAt(sx, sy) {
    const world = screenToWorld(sx, sy);
    const cell = worldToFogCell(world.x, world.y);
    const r = fogBrush;
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (di * di + dj * dj > r * r) continue;
        const key = (cell.i + di) + ',' + (cell.j + dj);
        if (fogHide) fogSet.add(key); else fogSet.delete(key);
      }
    }
    draw();
  }

  function applyZone(rect) {
    const c0 = worldToFogCell(Math.min(rect.x0, rect.x1), Math.min(rect.y0, rect.y1));
    const c1 = worldToFogCell(Math.max(rect.x0, rect.x1), Math.max(rect.y0, rect.y1));
    for (let j = c0.j; j <= c1.j; j++) {
      for (let i = c0.i; i <= c1.i; i++) {
        const key = i + ',' + j;
        if (fogHide) fogSet.add(key); else fogSet.delete(key);
      }
    }
    draw();
  }
  // -----------------------------------------------------------------------

  function setMoveHandler(fn) { moveHandler = fn; }
  function setSelectHandler(fn) { selectHandler = fn; }

  function selectTarget(type, id) {
    selectedTarget = id ? { type, id } : null;
    if (selectHandler) selectHandler(selectedTarget);
    draw();
  }

  // Снять выбор (кто бросает кубик / кого двигает следующий тап) — только если
  // он есть, чтобы глобальный сброс «по любому клику» не дёргал
  // requestReachable() и перерисовку на каждое нажатие.
  function clearSelection() {
    if (!selectedTarget) return;
    selectTarget(null, null);
  }

  function setReachable(cells) {
    reachableCells = new Map(cells.map((c) => [`${c.x},${c.y}`, c.cost]));
    draw();
  }

  function initCamera() {
    const saved = loadSavedCamera();
    if (saved) {
      camera.x = saved.x;
      camera.y = saved.y;
      camera.zoom = clamp(saved.zoom, ZOOM_MIN, ZOOM_MAX);
      clampCamera();
      return;
    }
    const layout = currentState.map;
    let targetChar = null;
    if (role === 'player' && myCharacterId) {
      targetChar = currentState.characters.find((c) => c.id === myCharacterId);
    }
    if (targetChar) {
      camera.x = (targetChar.position.x + 0.5) * layout.cellSize;
      camera.y = (targetChar.position.y + 0.5) * layout.cellSize + 20;
    } else {
      camera.x = (layout.gridWidth * layout.cellSize) / 2;
      camera.y = (layout.gridHeight * layout.cellSize) / 2 + 20;
    }
  }

  // Телепорт камеры к своему персонажу (игрок жмёт пробел). Берём актуальную
  // позицию из currentState — initCamera() центрирует только один раз при старте.
  function centerOnMyCharacter() {
    if (!currentState || !currentState.map || role !== 'player' || !myCharacterId) return;
    const targetChar = currentState.characters.find((c) => c.id === myCharacterId);
    if (!targetChar || !targetChar.position) return;
    const layout = currentState.map;
    camera.x = (targetChar.position.x + 0.5) * layout.cellSize;
    camera.y = (targetChar.position.y + 0.5) * layout.cellSize + 20;
    clampCamera();
    draw();
    saveCameraDebounced();
  }

  // Карта бесконечная, но камеру не отпускаем в пустоту (там легко потеряться):
  // границы — «домашняя область» локации ∪ картинки ∪ токены, плюс запас
  // CAMERA_CONTENT_MARGIN. Ушёл токен или положили картинку дальше — границы
  // растут сами.
  function clampCamera() {
    if (!currentState || !currentState.map) return;
    const { cellSize, gridWidth, gridHeight } = currentState.map;
    let minX = 0;
    let minY = 20;
    let maxX = gridWidth * cellSize;
    let maxY = gridHeight * cellSize + 20;
    const include = (x, y) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    };
    (currentState.mapImages || []).forEach((m) => mapImageCorners(m).forEach((p) => include(p.x, p.y)));
    const includeToken = (pos) => include((pos.x + 0.5) * cellSize, (pos.y + 0.5) * cellSize + 20);
    (currentState.characters || []).forEach((c) => { if (c.position) includeToken(c.position); });
    (currentState.npcs || []).forEach((n) => {
      if (n.position && n.locationId === currentState.activeLocationId) includeToken(n.position);
    });
    camera.x = clamp(camera.x, minX - CAMERA_CONTENT_MARGIN, maxX + CAMERA_CONTENT_MARGIN);
    camera.y = clamp(camera.y, minY - CAMERA_CONTENT_MARGIN, maxY + CAMERA_CONTENT_MARGIN);
  }

  function updateState(state) {
    // Смена активной локации — камера прежней локации тут не годится
    // (другой размер сетки), поэтому переинициализируем её для новой.
    const isFirst = !currentState;
    const locationChanged = currentState && currentState.activeLocationId !== state.activeLocationId;
    currentState = state;
    combatActive = !!(state && state.combat && state.combat.active);
    // Анимацию ходьбы не запускаем на первом state, при смене локации (позиции
    // подменяются целиком), в фоновой вкладке, при prefers-reduced-motion и
    // сразу после реконнекта.
    syncTokenAnimations(state, isFirst || !!locationChanged || document.hidden
      || !!(reduceMotionQuery && reduceMotionQuery.matches) || skipNextAnim);
    skipNextAnim = false;
    if (role !== 'gm' && state && state.characters) {
      const me = state.characters.find((c) => c.id === myCharacterId);
      if (me && me.color) drawColor = me.color;
    }
    if (locationChanged) cameraInitialized = false;
    // Линия линейки привязана к клеткам прежней локации — на новой она бессмысленна.
    if (locationChanged && ruler) {
      ruler = null;
      rulerDragging = false;
      notifyRuler();
    }
    // Выбранная картинка пропала (удалена) или сцена сменилась — снимаем выбор и жесты,
    // иначе рамка/ручки «висели» бы над несуществующей картинкой.
    if (selectedMapImageId
        && (locationChanged || !(state.mapImages || []).some((m) => m.id === selectedMapImageId))) {
      selectedMapImageId = null;
      imageDragging = null;
      imageResizing = null;
      imageRotating = null;
      if (mapImageSelectHandler) mapImageSelectHandler(null);
    }
    // Выбор ГМ не должен «висеть»: при смене локации и когда выбранного
    // персонажа/NPC уже удалили — иначе следующий тап шлёт ход несуществующему.
    if (role === 'gm' && selectedTarget) {
      const list = selectedTarget.type === 'npc' ? state.npcs : state.characters;
      const exists = !!(list && list.some((e) => e.id === selectedTarget.id));
      if (locationChanged || !exists) clearSelection();
    }
    if (!cameraInitialized && state && state.map) {
      initCamera();
      cameraInitialized = true;
    }
    // Есть что анимировать — запускаем цикл (он сам делает draw() на каждом кадре).
    if (tokenAnims.size || walkFx.length) startAnimLoop();
    else draw();
  }

  function ensureCanvasSize() {
    const parent = canvas.parentElement;
    const rect = parent.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - canvas.width / 2) / camera.zoom + camera.x,
      y: (sy - canvas.height / 2) / camera.zoom + camera.y,
    };
  }

  function eventToCanvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function cellFromCanvasPoint(sx, sy) {
    if (!currentState) return null;
    const cellSize = currentState.map.cellSize;
    const world = screenToWorld(sx, sy);
    return { x: Math.floor(world.x / cellSize), y: Math.floor((world.y - 20) / cellSize) };
  }

  // Убитый персонаж игрока сам не ходит (сервер тоже отклонит: moveCharacter,
  // reason 'dead') — клиент не шлёт ход и показывает курсор «нельзя».
  function isMyCharacterDead() {
    const me = currentState && currentState.characters.find((c) => c.id === myCharacterId);
    return !!(me && me.dead);
  }

  function handleTap(sx, sy) {
    if (!currentState) return;
    const { x, y } = cellFromCanvasPoint(sx, sy);

    const clickedCharacter = currentState.characters.find(
      (c) => c.position.x === x && c.position.y === y
    );
    // У ГМ повторный тап по уже выбранному токену снимает выбор (как повторный
    // клик по карточке). Тап по пустой клетке сюда не попадает — это ход.
    if (clickedCharacter && (role === 'gm' || clickedCharacter.id === myCharacterId)) {
      const alreadySelected = role === 'gm' && selectedTarget
        && selectedTarget.type === 'character' && selectedTarget.id === clickedCharacter.id;
      if (alreadySelected) selectTarget(null, null);
      else selectTarget('character', clickedCharacter.id);
      return;
    }

    // NPC выбираются и перемещаются только мастером — игроки их вообще не видят.
    const clickedNpc = role === 'gm' && currentState.npcs
      ? currentState.npcs.find((n) => n.position && n.locationId === currentState.activeLocationId && n.position.x === x && n.position.y === y)
      : null;
    if (clickedNpc) {
      const alreadySelected = selectedTarget && selectedTarget.type === 'npc' && selectedTarget.id === clickedNpc.id;
      if (alreadySelected) selectTarget(null, null);
      else selectTarget('npc', clickedNpc.id);
      return;
    }

    if (!selectedTarget) return;

    if (role === 'gm') {
      if (moveHandler) moveHandler(selectedTarget, x, y);
      return;
    }

    if (isMyCharacterDead()) return;

    // Вне боя перемещение свободное — не гейтим тап подсветкой достижимости
    // (сервер и не считает её вне боя, см. gameState.getReachableCells).
    if (!combatActive || reachableCells.has(`${x},${y}`)) {
      if (moveHandler) moveHandler(selectedTarget, x, y);
    }
  }

  function pointerDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // Курсор для угла масштабирования картинки — точное направление по вектору
  // от центра картинки до угла (учитывает текущий поворот m.rotation, т.к.
  // corners уже повёрнуты, см. mapImageCorners).
  function resizeCursorForAngle(dx, dy) {
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const mod = ((deg % 180) + 180) % 180;
    if (mod < 22.5 || mod >= 157.5) return 'ew-resize';
    if (mod < 67.5) return 'nwse-resize';
    if (mod < 112.5) return 'ns-resize';
    return 'nesw-resize';
  }

  // Курсор для состояния "мышь наведена, но кнопка не нажата" — зеркалит
  // приоритет веток pointerdown (туман → картинки → эффекты → рисование →
  // обычный тап), чтобы курсор всегда соответствовал тому, что реально
  // произойдёт по клику.
  function cursorForHover(sx, sy) {
    const world = screenToWorld(sx, sy);

    if (role === 'gm' && fogEdit) return 'crosshair';

    if (imageEditActive()) {
      if (findRotateHandleAt(world.x, world.y)) return 'crosshair'; // приближение, нет родного "rotate"
      const handleHit = findMapImageHandleAt(world.x, world.y);
      if (handleHit) {
        const c = handleHit.corners[handleHit.cornerIndex];
        return resizeCursorForAngle(c.x - handleHit.m.x, c.y - handleHit.m.y);
      }
      const hit = findMapImageAt(world.x, world.y);
      if (hit) return hit.locked ? 'not-allowed' : 'grab';
      return 'grab';
    }

    if (vfxPlaceMode) return 'crosshair';

    if (rulerMode) return 'crosshair';

    if (drawMode) return drawTool === 'eraser' ? 'cell' : 'crosshair';

    if (!currentState) return 'grab';
    const cell = cellFromCanvasPoint(sx, sy);
    const { x, y } = cell;
    const overCharacter = currentState.characters.some(
      (c) => c.position.x === x && c.position.y === y && (role === 'gm' || c.id === myCharacterId)
    );
    const overNpc = role === 'gm' && currentState.npcs
      ? currentState.npcs.some((n) => n.position && n.locationId === currentState.activeLocationId && n.position.x === x && n.position.y === y)
      : false;
    if (overCharacter || overNpc) return 'pointer';

    if (selectedTarget) {
      if (role === 'player' && (isMyCharacterDead() || (combatActive && !reachableCells.has(`${x},${y}`)))) return 'not-allowed';
      return 'pointer';
    }
    return 'grab';
  }

  let lastHoverPoint = null; // для пересчёта курсора при переключении режима без движения мыши

  canvas.addEventListener('mousemove', (e) => {
    if (activePointers.size > 0) return; // активный жест сам управляет курсором (см. pointerdown/endPointer)
    const pt = eventToCanvasPoint(e);
    lastHoverPoint = pt;
    canvas.style.cursor = cursorForHover(pt.x, pt.y);
  });

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastPointerType = e.pointerType || 'mouse'; // от него зависит зона попадания по ручкам картинки
    if (activePointers.size === 1) {
      const isMouse = e.pointerType === 'mouse';
      // ГМ рисует туман: тач/перо или ЛКМ перехватывают жест под кисть/зону.
      if (role === 'gm' && fogEdit && (!isMouse || e.button === 0)) {
        fogPainting = true;
        canvas.style.cursor = 'crosshair';
        const pt = eventToCanvasPoint(e);
        if (fogTool === 'brush') {
          paintBrushAt(pt.x, pt.y);
        } else {
          const w = screenToWorld(pt.x, pt.y);
          fogSelection = { x0: w.x, y0: w.y, x1: w.x, y1: w.y };
        }
        return;
      }
      // Режим редактирования картинок (ГМ — любые, игрок — только свои): сначала
      // проверяем ручки выбранной картинки (поворот/масштаб), иначе — захват/выбор
      // картинки под точкой.
      if (imageEditActive() && (!isMouse || e.button === 0)) {
        // Жест целиком принадлежит режиму картинок: если он ничего не захватил (клик мимо,
        // чужая/заблокированная картинка), endPointer не должен превратить его в тап по
        // клетке — иначе у игрока (его токен всегда выбран) клик по пустому месту двигал бы токен.
        suppressTap = true;
        const pt = eventToCanvasPoint(e);
        const world = screenToWorld(pt.x, pt.y);
        const rotateHit = findRotateHandleAt(world.x, world.y);
        if (rotateHit) {
          const m = rotateHit;
          imageRotating = {
            id: m.id,
            rotation0: m.rotation || 0,
            startAngle: Math.atan2(world.y - m.y, world.x - m.x),
          };
          canvas.style.cursor = 'crosshair';
          return;
        }
        const handleHit = findMapImageHandleAt(world.x, world.y);
        if (handleHit) {
          const { m, cornerIndex, corners } = handleHit;
          // Противоположный угол остаётся неподвижным «якорем» масштабирования.
          const anchor = corners[(cornerIndex + 2) % 4];
          const dragCorner = corners[cornerIndex];
          imageResizing = {
            id: m.id,
            anchorX: anchor.x,
            anchorY: anchor.y,
            dirX: dragCorner.x - anchor.x,
            dirY: dragCorner.y - anchor.y,
            length0: Math.hypot(dragCorner.x - anchor.x, dragCorner.y - anchor.y),
            scale0: m.scale,
          };
          canvas.style.cursor = resizeCursorForAngle(dragCorner.x - anchor.x, dragCorner.y - anchor.y);
          return;
        }
        const hit = findMapImageAt(world.x, world.y);
        selectedMapImageId = hit ? hit.id : null;
        if (hit && !hit.locked && canEditImage(hit)) {
          imageDragging = { id: hit.id, offsetX: world.x - hit.x, offsetY: world.y - hit.y };
          canvas.style.cursor = 'grabbing';
        }
        if (mapImageSelectHandler) mapImageSelectHandler(selectedMapImageId);
        draw();
        return;
      }
      // Спецэффекты доступны и ГМ, и игрокам (в отличие от тумана/картинок).
      // Один клик — один эффект в точке клика; режим НЕ гасится (можно
      // ставить подряд), в отличие от drawMode ниже это не жест, а тап.
      if (vfxPlaceMode && (!isMouse || e.button === 0)) {
        const pt = eventToCanvasPoint(e);
        const world = screenToWorld(pt.x, pt.y);
        if (vfxPlaceHandler) vfxPlaceHandler(vfxPlaceMode, world.x, world.y);
        suppressTap = true;
        return;
      }
      // Линейка (ГМ и игрок): нажатие ставит начало, движение — конец, оба привязаны к
      // клеткам. Жест целиком принадлежит линейке — тапом по клетке (ходом) он не станет.
      if (rulerMode && (!isMouse || e.button === 0)) {
        const pt = eventToCanvasPoint(e);
        const cell = cellFromCanvasPoint(pt.x, pt.y);
        suppressTap = true;
        canvas.style.cursor = 'crosshair';
        if (cell) {
          ruler = { a: cell, b: { x: cell.x, y: cell.y } };
          rulerDragging = true;
          notifyRuler();
          draw();
        }
        return;
      }
      // Рисование доступно и ГМ, и игрокам (в отличие от тумана/картинок).
      if (drawMode && (!isMouse || e.button === 0)) {
        const pt = eventToCanvasPoint(e);
        const world = screenToWorld(pt.x, pt.y);
        canvas.style.cursor = drawTool === 'eraser' ? 'cell' : 'crosshair';
        if (drawTool === 'eraser') {
          drawErasing = true;
          erasedThisGesture = new Set();
          eraseAt(world.x, world.y);
        } else {
          currentStroke = { points: [{ x: world.x, y: world.y }] };
          draw();
        }
        return;
      }
      dragStart = { x: e.clientX, y: e.clientY };
      dragMoved = false;
      // Панорамирование: у мыши только средняя (1) / правая (2) кнопка;
      // тач/перо — одним касанием. ЛКМ мыши оставляем под тап/выбор.
      const isPanInput = !isMouse || e.button === 1 || e.button === 2;
      panButton = isPanInput && isMouse ? e.button : null;
      if (isPanInput) {
        dragLast = { x: e.clientX, y: e.clientY };
        suppressTap = isMouse;
        canvas.style.cursor = 'grabbing';
        if (isMouse) e.preventDefault();
      } else {
        dragLast = null;
        suppressTap = false;
      }
    } else if (activePointers.size === 2) {
      const pts = [...activePointers.values()];
      pinchStartDist = pointerDistance(pts[0], pts[1]);
      pinchStartZoom = camera.zoom;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (rulerDragging) {
      const pt = eventToCanvasPoint(e);
      const cell = cellFromCanvasPoint(pt.x, pt.y);
      if (cell && ruler && (cell.x !== ruler.b.x || cell.y !== ruler.b.y)) {
        ruler.b = cell;
        notifyRuler();
        draw();
      }
      return;
    }

    if (fogPainting) {
      const pt = eventToCanvasPoint(e);
      if (fogTool === 'brush') {
        paintBrushAt(pt.x, pt.y);
      } else if (fogSelection) {
        const w = screenToWorld(pt.x, pt.y);
        fogSelection.x1 = w.x;
        fogSelection.y1 = w.y;
        draw();
      }
      return;
    }

    if (imageDragging) {
      const pt = eventToCanvasPoint(e);
      const world = screenToWorld(pt.x, pt.y);
      const m = currentState && currentState.mapImages && currentState.mapImages.find((mi) => mi.id === imageDragging.id);
      if (m) {
        m.x = world.x - imageDragging.offsetX;
        m.y = world.y - imageDragging.offsetY;
        draw();
      }
      return;
    }

    if (imageResizing) {
      const pt = eventToCanvasPoint(e);
      const world = screenToWorld(pt.x, pt.y);
      const m = currentState && currentState.mapImages && currentState.mapImages.find((mi) => mi.id === imageResizing.id);
      if (m) {
        const { anchorX, anchorY, dirX, dirY, length0, scale0 } = imageResizing;
        const dx = world.x - anchorX;
        const dy = world.y - anchorY;
        const ratio = length0 > 0 ? (dx * dirX + dy * dirY) / (length0 * length0) : 1;
        m.scale = clamp(scale0 * ratio, 0.05, 10);
        const newCornerX = anchorX + dirX * ratio;
        const newCornerY = anchorY + dirY * ratio;
        m.x = (anchorX + newCornerX) / 2;
        m.y = (anchorY + newCornerY) / 2;
        draw();
      }
      return;
    }

    if (imageRotating) {
      const pt = eventToCanvasPoint(e);
      const world = screenToWorld(pt.x, pt.y);
      const m = currentState && currentState.mapImages && currentState.mapImages.find((mi) => mi.id === imageRotating.id);
      if (m) {
        const angle = Math.atan2(world.y - m.y, world.x - m.x);
        m.rotation = imageRotating.rotation0 + (angle - imageRotating.startAngle);
        draw();
      }
      return;
    }

    if (drawErasing) {
      const pt = eventToCanvasPoint(e);
      const world = screenToWorld(pt.x, pt.y);
      eraseAt(world.x, world.y);
      return;
    }

    if (currentStroke) {
      const pt = eventToCanvasPoint(e);
      const world = screenToWorld(pt.x, pt.y);
      const last = currentStroke.points[currentStroke.points.length - 1];
      // Не копим точки чаще минимального расстояния — иначе гигантские
      // массивы при быстром движении мыши (см. MAX_STROKE_POINTS на сервере).
      if (currentStroke.points.length < 3000 && Math.hypot(world.x - last.x, world.y - last.y) >= 2 / camera.zoom) {
        currentStroke.points.push({ x: world.x, y: world.y });
        draw();
      }
      return;
    }

    if (activePointers.size === 1 && dragLast) {
      const dx = e.clientX - dragLast.x;
      const dy = e.clientY - dragLast.y;
      if (Math.abs(e.clientX - dragStart.x) > 4 || Math.abs(e.clientY - dragStart.y) > 4) dragMoved = true;
      camera.x -= dx / camera.zoom;
      camera.y -= dy / camera.zoom;
      dragLast = { x: e.clientX, y: e.clientY };
      clampCamera();
      draw();
      saveCameraDebounced();
    } else if (activePointers.size === 2 && pinchStartDist) {
      const pts = [...activePointers.values()];
      const dist = pointerDistance(pts[0], pts[1]);
      camera.zoom = clamp(pinchStartZoom * (dist / pinchStartDist), ZOOM_MIN, ZOOM_MAX);
      clampCamera();
      draw();
      saveCameraDebounced();
    }
  });

  function endPointer(e) {
    const pt = eventToCanvasPoint(e);
    // Линейка: отпустили — линия остаётся; дальше обычный путь (suppressTap, поставленный
    // в pointerdown, не даёт превратить жест в тап по клетке).
    rulerDragging = false;
    if (imageDragging) {
      const m = currentState && currentState.mapImages && currentState.mapImages.find((mi) => mi.id === imageDragging.id);
      imageDragging = null;
      activePointers.delete(e.pointerId);
      if (m && mapImageUpdateHandler) mapImageUpdateHandler({ id: m.id, x: m.x, y: m.y });
      draw();
      canvas.style.cursor = cursorForHover(pt.x, pt.y);
      return;
    }
    if (imageResizing) {
      const m = currentState && currentState.mapImages && currentState.mapImages.find((mi) => mi.id === imageResizing.id);
      imageResizing = null;
      activePointers.delete(e.pointerId);
      if (m && mapImageUpdateHandler) mapImageUpdateHandler({ id: m.id, x: m.x, y: m.y, scale: m.scale });
      draw();
      canvas.style.cursor = cursorForHover(pt.x, pt.y);
      return;
    }
    if (imageRotating) {
      const m = currentState && currentState.mapImages && currentState.mapImages.find((mi) => mi.id === imageRotating.id);
      imageRotating = null;
      activePointers.delete(e.pointerId);
      if (m && mapImageUpdateHandler) mapImageUpdateHandler({ id: m.id, rotation: m.rotation });
      draw();
      canvas.style.cursor = cursorForHover(pt.x, pt.y);
      return;
    }
    if (fogPainting) {
      if (fogTool === 'zone' && fogSelection) {
        applyZone(fogSelection);
        fogSelection = null;
      }
      fogPainting = false;
      activePointers.delete(e.pointerId);
      if (fogChangeHandler) fogChangeHandler(getFogBlob());
      draw();
      canvas.style.cursor = cursorForHover(pt.x, pt.y);
      return;
    }
    if (drawErasing) {
      drawErasing = false;
      erasedThisGesture = null;
      activePointers.delete(e.pointerId);
      draw();
      canvas.style.cursor = cursorForHover(pt.x, pt.y);
      return;
    }
    if (currentStroke) {
      const stroke = currentStroke;
      currentStroke = null;
      activePointers.delete(e.pointerId);
      draw();
      if (stroke.points.length >= 1 && drawAddHandler) {
        drawAddHandler({ points: stroke.points, width: drawWidth });
      }
      canvas.style.cursor = cursorForHover(pt.x, pt.y);
      return;
    }
    const wasSingle = activePointers.size === 1 && activePointers.has(e.pointerId);
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchStartDist = null;
    if (activePointers.size < 1) dragLast = null;
    if (wasSingle && !dragMoved && !suppressTap) {
      handleTap(pt.x, pt.y);
    }
    // ПКМ без движения в режиме рисования — отмена последнего штриха; ПКМ с
    // движением остаётся панорамированием. При взведённом эффекте рисовать
    // нельзя (ветка vfx в pointerdown приоритетнее), поэтому и undo не нужен.
    if (wasSingle && !dragMoved && panButton === 2 && e.type === 'pointerup'
        && drawMode && !vfxPlaceMode && drawUndoHandler) {
      drawUndoHandler();
    }
    panButton = null;
    suppressTap = false;
    canvas.style.cursor = cursorForHover(pt.x, pt.y);
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  // ПКМ используется для панорамирования — гасим системное контекстное меню.
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const pt = eventToCanvasPoint(e);
    const before = screenToWorld(pt.x, pt.y);
    const factor = Math.exp(-e.deltaY * 0.001);
    camera.zoom = clamp(camera.zoom * factor, ZOOM_MIN, ZOOM_MAX);
    const after = screenToWorld(pt.x, pt.y);
    camera.x += before.x - after.x;
    camera.y += before.y - after.y;
    clampCamera();
    draw();
    saveCameraDebounced();
  }, { passive: false });

  if (window.ResizeObserver) {
    new ResizeObserver(() => draw()).observe(canvas.parentElement);
  } else {
    window.addEventListener('resize', () => draw());
  }
  // Подписи рисуются шрифтом интерфейса: как только он догрузится — перечитать токены и перерисовать
  // (иначе первый кадр остался бы с запасным шрифтом).
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { readTheme(); draw(); });

  function draw() {
    ensureCanvasSize();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!currentState || !currentState.map) return;
    const layout = currentState.map;
    const { cellSize } = layout;

    ctx.save();
    ctx.translate(canvas.width / 2 - camera.x * camera.zoom, canvas.height / 2 - camera.y * camera.zoom);
    ctx.scale(camera.zoom, camera.zoom);

    // Картинки, наложенные мастером на карту (хендауты/доп. арт/фон — всё,
    // что мастер сам загрузил через «Картинки»; движок своего фона не задаёт).
    if (currentState.mapImages) {
      currentState.mapImages.forEach((m) => {
        const img = getAvatarImage(m.url, draw);
        if (!img) return;
        const w = m.naturalWidth * m.scale;
        const h = m.naturalHeight * m.scale;
        const angle = m.rotation || 0;
        // Поворот — через save/translate/rotate вокруг центра картинки, рисуем
        // от -w/2,-h/2 в повёрнутой системе координат.
        ctx.save();
        ctx.translate(m.x, m.y);
        ctx.rotate(angle);
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        ctx.restore();
      });
    }

    // Сетка — поверх картинок (для ориентирования по клеткам всегда должна
    // быть видна), но под туманом/reachable-подсветкой/токенами.
    drawGrid();

    // Пока выбранный токен идёт, подсветку достижимых клеток не рисуем: ромб
    // пересчитан от новой клетки и «убегал» бы вперёд токена. После ходьбы её
    // вернёт финальный кадр анимационного цикла.
    const cellInset = Math.max(1, cellSize * 0.05);
    const selectedWalking = !!selectedTarget && tokenAnims.has(tokenKey(selectedTarget.type, selectedTarget.id));
    if (!selectedWalking) {
      reachableCells.forEach((cost, key) => {
        const [x, y] = key.split(',').map(Number);
        ctx.fillStyle = 'rgba(92, 196, 141, 0.12)';
        ctx.fillRect(x * cellSize + cellInset, y * cellSize + 20 + cellInset, cellSize - cellInset * 2, cellSize - cellInset * 2);
      });
    }

    // Спецэффекты (дым/огонь/фейерверк) — над картинками/сеткой/reachable,
    // но ПОД туманом (см. CLAUDE.md): туман красится сразу следующим блоком
    // и скрывает эффект в непроявленных клетках, как обычный фон.
    drawEffects();

    // Туман скрывает фон и reachable, но токены рисуются поверх — они видны всегда.
    // Туман не привязан ни к какому прямоугольнику — рисуем только клетки,
    // попавшие в видимую область экрана (в мировых координатах).
    if (fogSet.size) {
      const viewMin = screenToWorld(0, 0);
      const viewMax = screenToWorld(canvas.width, canvas.height);
      const i0 = Math.floor(viewMin.x / FOG_CELL) - 1;
      const j0 = Math.floor(viewMin.y / FOG_CELL) - 1;
      const i1 = Math.floor(viewMax.x / FOG_CELL) + 1;
      const j1 = Math.floor(viewMax.y / FOG_CELL) + 1;
      // Клетки красим одним path'ом (rect+fill), а не отдельными fillRect —
      // иначе на стыках соседних клеток при дробном зуме остаются тонкие
      // щели (каждый fillRect сглаживается по краю независимо от соседа).
      ctx.beginPath();
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (fogSet.has(i + ',' + j)) ctx.rect(i * FOG_CELL, j * FOG_CELL, FOG_CELL, FOG_CELL);
        }
      }
      ctx.fillStyle = role === 'gm' ? 'rgba(12,14,20,0.7)' : THEME.bg;
      ctx.fill();
      if (role === 'gm') {
        ctx.beginPath();
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            if (fogSet.has(i + ',' + j)) ctx.rect(i * FOG_CELL, j * FOG_CELL, FOG_CELL, FOG_CELL);
          }
        }
        ctx.fillStyle = getFogHatchPattern(ctx);
        ctx.fill();
      }
    }

    // Рисунки игроков/мастера — как и токены, всегда видны поверх тумана.
    // Мировые координаты, без привязки к клеткам сетки.
    if (currentState.drawings) {
      currentState.drawings.forEach((d) => {
        if (!d.points || !d.points.length) return;
        ctx.save();
        ctx.strokeStyle = d.color;
        ctx.fillStyle = d.color;
        ctx.lineWidth = Math.max(1, d.width);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (d.points.length === 1) {
          ctx.beginPath();
          ctx.arc(d.points[0].x, d.points[0].y, d.width / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(d.points[0].x, d.points[0].y);
          d.points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
          ctx.stroke();
        }
        ctx.restore();
      });
    }
    // Черновик текущего незавершённого штриха (пока пойнтер зажат).
    if (currentStroke && currentStroke.points.length > 1) {
      ctx.save();
      ctx.strokeStyle = drawColor;
      ctx.lineWidth = Math.max(1, drawWidth);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(currentStroke.points[0].x, currentStroke.points[0].y);
      currentStroke.points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.stroke();
      ctx.restore();
    }

    // Следы ходьбы — над туманом, под токенами (см. drawWalkFx).
    drawWalkFx();

    // Отрисовывает один токен (персонаж или NPC) — аватар/буква-заглушка + подпись.
    // pose — отображаемая поза (getTokenPose): дробная позиция в клетках при
    // ходьбе и lift — подпрыгивание на шаге. Тело токена поднимается на lift,
    // подпись остаётся на высоте земли (не дрожит).
    // ringWidth — толщина кольца вокруг аватара (у NPC толще: цвет фракции должен читаться).
    // marker — { shape, color } значок фракции NPC перед нижней строкой подписи (имя).
    function drawToken(entity, pose, isSelected, fallbackColor, labelLines, isDead, ringWidth = 2, marker = null) {
      const cx = (pose.x + 0.5) * cellSize;
      const groundY = (pose.y + 0.5) * cellSize + 20;
      const cy = groundY - pose.lift;
      const r = cellSize * 0.35;
      const avatarImg = getAvatarImage(entity.avatar, draw);

      if (avatarImg) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(avatarImg, cx - r, cy - r, r * 2, r * 2);
        ctx.restore();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.lineWidth = (isSelected ? Math.max(3, ringWidth) : ringWidth) / camera.zoom;
        ctx.strokeStyle = isSelected ? '#fff' : fallbackColor;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = fallbackColor;
        ctx.fill();
        if (isSelected) {
          ctx.lineWidth = 2 / camera.zoom;
          ctx.strokeStyle = '#fff';
          ctx.stroke();
        }
        ctx.fillStyle = '#fff';
        ctx.font = `600 ${cellSize * 0.3}px ${THEME.font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(entity.name[0], cx, cy);
        ctx.textBaseline = 'alphabetic';
      }

      // Крестик поверх иконки — NPC отмечен мастером как убитый.
      if (isDead) {
        ctx.save();
        ctx.lineWidth = Math.max(2, cellSize * 0.05) / camera.zoom;
        ctx.strokeStyle = THEME.danger;
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.7, cy - r * 0.7);
        ctx.lineTo(cx + r * 0.7, cy + r * 0.7);
        ctx.moveTo(cx + r * 0.7, cy - r * 0.7);
        ctx.lineTo(cx - r * 0.7, cy + r * 0.7);
        ctx.stroke();
        ctx.restore();
      }

      // Подпись над токеном — с обводкой для читаемости на любом фоне.
      const lineHeight = cellSize * 0.325;
      const fontPx = cellSize * 0.275;
      ctx.font = `600 ${fontPx}px ${THEME.font}`;
      ctx.textAlign = 'center';
      ctx.lineWidth = Math.max(1, cellSize * 0.075) / camera.zoom;
      ctx.strokeStyle = 'rgba(10, 11, 15, 0.85)';
      ctx.fillStyle = THEME.text;
      labelLines.slice().reverse().forEach((line, i) => {
        const y = groundY - r - cellSize * 0.1 - i * lineHeight;
        if (marker && i === 0) {
          // Значок фракции слева от имени; вместе они центрируются над токеном.
          const mr = fontPx * 0.5;
          const gap = fontPx * 0.35;
          const textW = ctx.measureText(line).width;
          const left = cx - (mr * 2 + gap + textW) / 2;
          drawFactionMarker(ctx, marker.shape, left + mr, y - fontPx * 0.33, mr, marker.color, Math.max(1, cellSize * 0.05) / camera.zoom);
          ctx.textAlign = 'left';
          ctx.strokeText(line, left + mr * 2 + gap, y);
          ctx.fillText(line, left + mr * 2 + gap, y);
          ctx.textAlign = 'center';
        } else {
          ctx.strokeText(line, cx, y);
          ctx.fillText(line, cx, y);
        }
      });
    }

    const poseNow = performance.now();
    currentState.characters.forEach((c) => {
      const isSelected = selectedTarget?.type === 'character' && selectedTarget.id === c.id;
      // Роль/имя персонажа сверху, а под ним — имя, введённое игроком при входе.
      const labelLines = c.claimedBy ? [c.name, c.claimedBy] : [c.name];
      drawToken(c, getTokenPose(tokenKey('character', c.id), c.position, poseNow), isSelected, c.color || '#888', labelLines, c.dead);
    });

    // NPC: игрокам сервер уже присылает только видимые (см. getPublicState),
    // мастеру — всех. Выбирать/двигать NPC может только мастер (см. handleTap).
    if (currentState.npcs) {
      currentState.npcs.filter((n) => n.position && n.locationId === currentState.activeLocationId).forEach((n) => {
        // Туман проверяем по ОТОБРАЖАЕМОЙ позиции: идущий NPC растворяется при
        // входе в туман и проявляется на выходе (по логической позиции игрок
        // увидел бы его стартовую точку в тумане).
        const pose = getTokenPose(tokenKey('npc', n.id), n.position, poseNow);
        const cx = (pose.x + 0.5) * cellSize;
        const cy = (pose.y + 0.5) * cellSize + 20;
        // Игроку NPC под туманом не рисуется вообще — тайна тумана войны.
        if (role === 'player' && isPositionFogged(cx, cy)) return;
        const isSelected = selectedTarget?.type === 'npc' && selectedTarget.id === n.id;
        // Полупрозрачность у мастера — подсказка, что NPC ещё скрыт от игроков.
        if (role === 'gm' && !n.visible) ctx.globalAlpha = 0.45;
        // Цвет фракции — кольцом/заливкой, значок — рядом с именем (враг/союзник/нейтрал).
        const faction = factionStyleFor(n);
        drawToken(n, pose, isSelected, faction.color, [n.name], n.dead, 3.5, faction);
        ctx.globalAlpha = 1;
      });
    }

    // Линейка — поверх токенов (линия читается над ними), но под рамкой картинки. Концы —
    // центры клеток; подпись — плашка над концом B; размеры делим на zoom, чтобы линия и
    // текст читались на любом масштабе.
    if (ruler) {
      const reading = rulerReading();
      const z = camera.zoom;
      const ax = (ruler.a.x + 0.5) * cellSize;
      const ay = (ruler.a.y + 0.5) * cellSize + 20;
      const bx = (ruler.b.x + 0.5) * cellSize;
      const by = (ruler.b.y + 0.5) * cellSize + 20;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(10, 11, 15, 0.8)'; // тёмная подложка — линия видна на любом фоне
      ctx.lineWidth = 6 / z;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.strokeStyle = THEME.amber;
      ctx.lineWidth = 3 / z;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      [[ax, ay], [bx, by]].forEach(([px, py]) => {
        ctx.beginPath();
        ctx.arc(px, py, 5 / z, 0, Math.PI * 2);
        ctx.fillStyle = THEME.amber;
        ctx.fill();
        ctx.lineWidth = 1.5 / z;
        ctx.strokeStyle = 'rgba(10, 11, 15, 0.9)';
        ctx.stroke();
      });
      const text = reading.moves === 0
        ? '0'
        : `Ход ${reading.moves} · Прямая ${String(reading.straight).replace('.', ',')}`;
      ctx.font = `600 ${13 / z}px ${THEME.font}`;
      const boxW = ctx.measureText(text).width + 16 / z;
      const boxH = 22 / z;
      const boxX = bx - boxW / 2;
      const boxY = by - 16 / z - boxH;
      ctx.fillStyle = THEME.surface;
      ctx.strokeStyle = THEME.amber;
      ctx.lineWidth = 1.5 / z;
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.strokeRect(boxX, boxY, boxW, boxH);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx, boxY + boxH / 2);
      ctx.restore();
    }

    // Рамка и ручки выбранной картинки — отдельным проходом ПОСЛЕ тумана и токенов: внутри
    // цикла по картинкам их перекрывали сетка и туман (у игрока он непрозрачный), и
    // править картинку было бы не видно. У игрока — только для его собственных.
    if (imageEditActive() && selectedMapImageId && currentState.mapImages) {
      const m = currentState.mapImages.find((mi) => mi.id === selectedMapImageId);
      if (m && canEditImage(m)) {
        const w = m.naturalWidth * m.scale;
        const h = m.naturalHeight * m.scale;
        const angle = m.rotation || 0;
        ctx.save();
        ctx.translate(m.x, m.y);
        ctx.rotate(angle);
        ctx.strokeStyle = m.locked ? THEME.danger : THEME.accent;
        ctx.lineWidth = 2 / camera.zoom;
        ctx.setLineDash([6 / camera.zoom, 4 / camera.zoom]);
        ctx.strokeRect(-w / 2, -h / 2, w, h);
        ctx.restore();
        if (!m.locked) {
          const visualRadius = IMAGE_HANDLE_RADIUS * (lastPointerType === 'mouse' ? 1 : 1.5);
          const handleSize = (visualRadius * 2) / camera.zoom;
          ctx.save();
          ctx.fillStyle = THEME.accent;
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5 / camera.zoom;
          mapImageCorners(m).forEach((c) => {
            ctx.fillRect(c.x - handleSize / 2, c.y - handleSize / 2, handleSize, handleSize);
            ctx.strokeRect(c.x - handleSize / 2, c.y - handleSize / 2, handleSize, handleSize);
          });
          ctx.restore();
          // Ручка поворота — кружок над верхней гранью, соединённый линией с картинкой.
          const topCenter = { x: m.x + Math.sin(angle) * (h / 2), y: m.y - Math.cos(angle) * (h / 2) };
          const rp = rotateHandlePosition(m);
          ctx.save();
          ctx.strokeStyle = THEME.accent;
          ctx.lineWidth = 1.5 / camera.zoom;
          ctx.beginPath();
          ctx.moveTo(topCenter.x, topCenter.y);
          ctx.lineTo(rp.x, rp.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(rp.x, rp.y, visualRadius / camera.zoom, 0, Math.PI * 2);
          ctx.fillStyle = THEME.accent;
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // Маркиза выделения зоны тумана (пунктир) — только пока ГМ тянет прямоугольник.
    if (fogSelection) {
      const x = Math.min(fogSelection.x0, fogSelection.x1);
      const y = Math.min(fogSelection.y0, fogSelection.y1);
      const w = Math.abs(fogSelection.x1 - fogSelection.x0);
      const h = Math.abs(fogSelection.y1 - fogSelection.y0);
      ctx.save();
      ctx.strokeStyle = fogHide ? 'rgba(255,90,90,0.95)' : 'rgba(120,200,255,0.95)';
      ctx.lineWidth = 2 / camera.zoom;
      ctx.setLineDash([6 / camera.zoom, 4 / camera.zoom]);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }

    ctx.restore();
  }

  return {
    updateState,
    // Следующий state применить без анимации ходьбы (после реконнекта позиции
    // могли уехать за время обрыва — не проигрывать всё разом).
    skipNextTokenAnimation: () => { skipNextAnim = true; },
    setReachable,
    selectTarget,
    clearSelection,
    setMoveHandler,
    setSelectHandler,
    getSelectedTarget: () => selectedTarget,
    // Включение любого режима карты (туман/картинки/рисование/эффекты) сбрасывает
    // выбор ГМ: иначе забытый выбранный токен можно случайно сдвинуть тапом.
    setFogEditMode: (v) => { fogEdit = !!v; if (fogEdit && role === 'gm') clearSelection(); if (!fogEdit) { fogSelection = null; fogPainting = false; } draw(); if (lastHoverPoint) canvas.style.cursor = cursorForHover(lastHoverPoint.x, lastHoverPoint.y); },
    setFogTool: (t) => { fogTool = t === 'zone' ? 'zone' : 'brush'; },
    setFogHide: (v) => { fogHide = !!v; },
    setFogBrush: (n) => { fogBrush = Math.max(0, Math.round(n)); },
    revealAllFog: () => { fogSet.clear(); draw(); if (fogChangeHandler) fogChangeHandler(getFogBlob()); },
    hideAllFog: () => { const b = getKnownMapBounds(); if (b) fillFogRect(b); draw(); if (fogChangeHandler) fogChangeHandler(getFogBlob()); },
    applyFogBlob,
    setFogChangeHandler: (fn) => { fogChangeHandler = fn; },
    centerOnMyCharacter,
    getCameraCenter: () => ({ x: camera.x, y: camera.y }),
    // Центрирует камеру на мировой точке (x,y) — например, на позиции
    // картинки на карте (m.x/m.y уже учитывают масштаб/поворот: это центр
    // отрисованного прямоугольника, см. блок currentState.mapImages.forEach
    // в draw()). Зум не меняем — только сдвигаем камеру.
    centerCameraOn: (x, y) => { camera.x = x; camera.y = y; clampCamera(); draw(); saveCameraDebounced(); },
    // У игрока выбор токена (selectedTarget — его персонаж) НЕ сбрасываем: без него тап-ход
    // не работает; режим правки у игрока касается только его собственных картинок.
    setImageEditMode: (v) => { imageEdit = !!v; if (imageEdit && role === 'gm') clearSelection(); if (!imageEdit) { imageDragging = null; imageResizing = null; imageRotating = null; selectedMapImageId = null; if (mapImageSelectHandler) mapImageSelectHandler(null); } draw(); if (lastHoverPoint) canvas.style.cursor = cursorForHover(lastHoverPoint.x, lastHoverPoint.y); },
    // Видимый размер мира в мировых px — для подбора начального масштаба вставляемой картинки.
    getViewSize: () => ({ w: canvas.width / camera.zoom, h: canvas.height / camera.zoom }),
    setMapImageSelectHandler: (fn) => { mapImageSelectHandler = fn; },
    setMapImageUpdateHandler: (fn) => { mapImageUpdateHandler = fn; },
    selectMapImage: (id) => { selectedMapImageId = id; draw(); },
    getSelectedMapImageId: () => selectedMapImageId,
    setDrawMode: (v) => { drawMode = !!v; if (drawMode && role === 'gm') clearSelection(); if (!drawMode) { currentStroke = null; drawErasing = false; erasedThisGesture = null; } draw(); if (lastHoverPoint) canvas.style.cursor = cursorForHover(lastHoverPoint.x, lastHoverPoint.y); },
    setDrawTool: (t) => { drawTool = t === 'eraser' ? 'eraser' : 'pen'; },
    setDrawWidth: (n) => { drawWidth = clamp(Math.round(n) || 4, 1, 24); },
    setDrawAddHandler: (fn) => { drawAddHandler = fn; },
    setDrawEraseHandler: (fn) => { drawEraseHandler = fn; },
    setDrawUndoHandler: (fn) => { drawUndoHandler = fn; },
    getMyDrawColor: () => drawColor,
    setVfxPlaceMode: (type) => { vfxPlaceMode = type || null; if (vfxPlaceMode && role === 'gm') clearSelection(); if (lastHoverPoint) canvas.style.cursor = cursorForHover(lastHoverPoint.x, lastHoverPoint.y); },
    setVfxPlaceHandler: (fn) => { vfxPlaceHandler = fn; },
    // Линейка: режим ведёт блок «Линейка» левой панели (RulerPanel.vue); выключение режима убирает линию.
    setRulerMode: (v) => {
      rulerMode = !!v;
      if (rulerMode && role === 'gm') clearSelection();
      if (!rulerMode) clearRuler();
      if (lastHoverPoint) canvas.style.cursor = cursorForHover(lastHoverPoint.x, lastHoverPoint.y);
    },
    clearRuler,
    setRulerChangeHandler: (fn) => { rulerChangeHandler = fn; },
    playEffect,
  };
}

window.createMapController = createMapController;
