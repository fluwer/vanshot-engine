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
const ZOOM_MAX = 12;              // клетка 16 px × 12 = 192 px: фишку можно рассмотреть вплотную
const FOG_BRUSH_MAX = 12;         // сторона квадратной кисти тумана, клеток (ползунок в панели — тот же предел)
const DRAW_WIDTH_PANEL_MAX = 16;  // толщина линии, до которой доходят клавиши и колесо (ползунок в панели — тот же предел)
const TOOL_WHEEL_STEP_PX = 40;    // Ctrl+колесо: сколько прокрутки на один шаг размера кисти/толщины (щелчок мыши = 100)
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Туман войны красит клетки сетки игры: ключ клетки «x,y» — тот же индекс, что у
// position токенов и у линейки (cellFromCanvasPoint), размер клетки и сдвиг сетки
// по Y берутся оттуда же. Туман не привязан к какому-либо прямоугольнику — клетки
// адресуются абсолютными индексами; сервер геометрию не знает, только хранит
// blob-строку (формат v2, см. getFogBlob).
const FOG_HATCH_TILE = 8; // плитка штриховки; делит cellSize (16) нацело — узор без обрезков
const FOG_FRAME_PAD_CELLS = 4; // запас (в клетках) вокруг картинок/комнат при «Скрыть всё»
const FOG_FX_MARGIN_CELLS = 4; // запас окна клеток для fogFx (блюр ±2 + классы ±1 + кадр): граница за краем экрана даёт дымку
const FOG_MAX_CELLS = 400000;  // предел клеток в одном blob при разборе (защита от мусора)
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
  let fogSet = new Set();      // скрытые клетки сетки ("x,y"), без привязки к рамке
  let fogVer = 0;              // растёт при любой правке fogSet — по нему игрок пересобирает сетку для fogFx
  let fogGrid = new Uint8Array(0); // сетка клеток окна для fogFx (1 = скрыта), переиспользуется
  let fogGridKey = '';
  let fogAnimating = false;    // последний кадр тумана просит анимацию (есть полоса у границы)
  let fogRafId = null;         // цикл анимации тумана игрока (свой, троттлинг по fogFx.targetFps)
  let fogLastTick = 0;
  let fogEdit = false;
  let fogTool = 'brush';       // 'brush' | 'zone'
  let fogHide = true;          // true = скрыть (красим чёрным), false = открыть
  let fogShiftHeld = false;    // Shift зажат — кисть временно работает в обратном режиме (см. fogHideNow)
  let fogBrush = 3;            // сторона квадратной кисти в клетках (1 = одна клетка)
  let fogSelection = null;     // { x0,y0,x1,y1 } мировой прямоугольник при зоне
  let fogHoverPt = null;       // точка указателя на канвасе (px) — по ней рисуется рамка клеток под кистью
  let fogHoverCells = null;    // { i0,j0,i1,j1 } клетки рамки в последнем draw() (чтобы не перерисовывать зря)
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
  let imageGesture = null;             // растяжение по сторонам / обрезка: см. startImageGesture
  let imageCropMode = false;           // режим обрезки: ручки тянут край обрезки (клавиша C)
  let mapImageActionHandler = null;    // горячие клавиши: ({ action: 'remove' | 'duplicate', id })
  const IMAGE_STRETCH_MIN = 0.1;       // как MAP_IMAGE_STRETCH_MIN/MAX и MAP_IMAGE_CROP_MIN_VISIBLE в server/config.js
  const IMAGE_STRETCH_MAX = 10;        // (сервер всё равно проверяет)
  const IMAGE_CROP_MIN_VISIBLE = 0.05;
  const IMAGE_MIN_SIDE = 8;            // мировые px: тоньше жест картинку не сожмёт (ручки слиплись бы)
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

  // Видимая часть картинки. К общему масштабу scale добавлены необязательные поля (у старых картинок их нет):
  // stretchX/stretchY — растяжение по одной оси, crop { l, t, r, b } — доли натурального размера, обрезанные
  // слева/сверху/справа/снизу (в осях исходного файла). m.x/m.y — центр ВИДИМОЙ части. Возвращает размер на карте
  // (w, h, мировые px), исходный прямоугольник (sx, sy, sw, sh — для drawImage), масштаб по осям (kx, ky: мировых px
  // на пиксель файла) и обрезку. Формулы те же, что imageVisibleSize в server/gameState.js.
  function imageBox(m) {
    const c = m.crop;
    const l = (c && c.l) || 0;
    const t = (c && c.t) || 0;
    const r = (c && c.r) || 0;
    const b = (c && c.b) || 0;
    const sw = m.naturalWidth * (1 - l - r);
    const sh = m.naturalHeight * (1 - t - b);
    const kx = m.scale * (m.stretchX || 1);
    const ky = m.scale * (m.stretchY || 1);
    return { w: sw * kx, h: sh * ky, sx: m.naturalWidth * l, sy: m.naturalHeight * t, sw, sh, kx, ky, l, t, r, b };
  }

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
      const { w, h } = imageBox(m);
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
    const { w, h } = imageBox(m);
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
    const { h } = imageBox(m);
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

  // Середины сторон в мировых координатах (с учётом поворота): N, E, S, W. Тянут сторону: растяжение в одну
  // сторону, а в режиме обрезки — край обрезки.
  function mapImageEdgeMids(m) {
    const { w, h } = imageBox(m);
    const angle = m.rotation || 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [{ x: 0, y: -h / 2 }, { x: w / 2, y: 0 }, { x: 0, y: h / 2 }, { x: -w / 2, y: 0 }].map((p) => ({
      x: m.x + p.x * cos - p.y * sin,
      y: m.y + p.x * sin + p.y * cos,
    }));
  }

  // Ручка изменения размера выбранной картинки под мировой точкой — проверяется только у уже выбранной.
  // Сначала углы (kind 'corner', index 0..3 = NW, NE, SE, SW), затем середины сторон (kind 'edge', 0..3 = N, E, S, W):
  // у маленькой картинки они почти сливаются, и угол важнее. { m, kind, index, point } | null.
  function findImageResizeHandleAt(wx, wy) {
    if (!currentState || !currentState.mapImages || !selectedMapImageId) return null;
    const m = currentState.mapImages.find((mi) => mi.id === selectedMapImageId);
    if (!m || m.locked || !canEditImage(m)) return null;
    const radius = handleHitRadius();
    const corners = mapImageCorners(m);
    for (let i = 0; i < corners.length; i++) {
      if (Math.hypot(wx - corners[i].x, wy - corners[i].y) <= radius) return { m, kind: 'corner', index: i, point: corners[i] };
    }
    const mids = mapImageEdgeMids(m);
    for (let i = 0; i < mids.length; i++) {
      if (Math.hypot(wx - mids[i].x, wy - mids[i].y) <= radius) return { m, kind: 'edge', index: i, point: mids[i] };
    }
    return null;
  }

  // ---- Растяжение по сторонам и обрезка (жест тянет одну-две стороны картинки) ----
  // Углы 0..3 — NW, NE, SE, SW; середины 0..3 — N, E, S, W. L/R — левая/правая сторона, T/B — верхняя/нижняя
  // (в осях картинки, то есть с учётом поворота, но без отражения).
  const CORNER_SIDES = [['L', 'T'], ['R', 'T'], ['R', 'B'], ['L', 'B']];
  const EDGE_SIDES = [['T'], ['R'], ['B'], ['L']];

  // Снимок картинки на старте жеста: дальше всё считается от него (а не накопительно) — без дрейфа.
  // mode 'stretch' меняет stretchX/stretchY, 'crop' — обрезку; противоположная сторона стоит на месте.
  function startImageGesture(m, kind, index, mode) {
    const box = imageBox(m);
    const angle = m.rotation || 0;
    imageGesture = {
      id: m.id,
      mode,
      sides: (kind === 'corner' ? CORNER_SIDES : EDGE_SIDES)[index],
      cx0: m.x,
      cy0: m.y,
      cos: Math.cos(angle),
      sin: Math.sin(angle),
      w0: box.w,
      h0: box.h,
      stretchX0: m.stretchX || 1,
      stretchY0: m.stretchY || 1,
      crop0: { l: box.l, t: box.t, r: box.r, b: box.b },
      kx: box.kx,
      ky: box.ky,
      nw: m.naturalWidth,
      nh: m.naturalHeight,
      flipX: !!m.flipX,
      flipY: !!m.flipY,
    };
  }

  // Одна ось жеста. sgn: +1 — двигается правая/нижняя сторона, −1 — левая/верхняя; pc — координата указателя
  // на этой оси (начало — центр на старте жеста). Возвращает новый размер, смещение центра и новое значение
  // (растяжение или доля обрезки), уже зажатые в допустимые пределы.
  function solveImageAxis(g, axis, sgn, pc) {
    const size0 = axis === 'x' ? g.w0 : g.h0;
    const fixed = (-sgn * size0) / 2; // противоположная сторона не двигается
    const want = Math.max(IMAGE_MIN_SIDE, (pc - fixed) * sgn);
    if (g.mode === 'stretch') {
      const s0 = axis === 'x' ? g.stretchX0 : g.stretchY0;
      const s = clamp((s0 * want) / size0, IMAGE_STRETCH_MIN, IMAGE_STRETCH_MAX);
      const size = (size0 * s) / s0;
      return { center: fixed + (sgn * size) / 2, stretch: s };
    }
    // Обрезка хранится в осях исходного файла: у отражённой картинки левая сторона на экране — правая в файле.
    const full = axis === 'x' ? g.nw * g.kx : g.nh * g.ky; // полный размер файла на карте по этой оси
    const flip = axis === 'x' ? g.flipX : g.flipY;
    const positive = sgn > 0;
    const trimKey = axis === 'x' ? (positive !== flip ? 'r' : 'l') : (positive !== flip ? 'b' : 't');
    const otherKey = { l: 'r', r: 'l', t: 'b', b: 't' }[trimKey];
    const other = g.crop0[otherKey];
    const trim = clamp(1 - want / full - other, 0, 1 - IMAGE_CROP_MIN_VISIBLE - other);
    const size = full * (1 - trim - other);
    return { center: fixed + (sgn * size) / 2, trimKey, trim };
  }

  // Применяет жест к картинке m для текущей точки указателя (мировые координаты): меняет m на месте,
  // сохранение на сервер — по отпусканию (см. pointerup).
  function applyImageGesture(m, world) {
    const g = imageGesture;
    const dx = world.x - g.cx0;
    const dy = world.y - g.cy0;
    const px = dx * g.cos + dy * g.sin;
    const py = -dx * g.sin + dy * g.cos;
    const mvX = g.sides.includes('R') ? 1 : g.sides.includes('L') ? -1 : 0;
    const mvY = g.sides.includes('B') ? 1 : g.sides.includes('T') ? -1 : 0;
    let ox = 0;
    let oy = 0;
    const crop = { ...g.crop0 };
    if (mvX) {
      const r = solveImageAxis(g, 'x', mvX, px);
      ox = r.center;
      if (r.stretch !== undefined) m.stretchX = r.stretch;
      else crop[r.trimKey] = r.trim;
    }
    if (mvY) {
      const r = solveImageAxis(g, 'y', mvY, py);
      oy = r.center;
      if (r.stretch !== undefined) m.stretchY = r.stretch;
      else crop[r.trimKey] = r.trim;
    }
    if (g.mode === 'crop') {
      if (!crop.l && !crop.t && !crop.r && !crop.b) delete m.crop; else m.crop = crop;
    } else {
      if (m.stretchX !== undefined && Math.abs(m.stretchX - 1) < 1e-4) delete m.stretchX;
      if (m.stretchY !== undefined && Math.abs(m.stretchY - 1) < 1e-4) delete m.stretchY;
    }
    // Центр — в осях картинки: c0 + u·ox + v·oy (u = (cos, sin), v = (−sin, cos)).
    m.x = g.cx0 + g.cos * ox - g.sin * oy;
    m.y = g.cy0 + g.sin * ox + g.cos * oy;
  }

  // Патч для сервера по окончании жеста: растяжение — оба множителя (null убирает поле), обрезка — объект или null.
  function imageGesturePatch(m, mode) {
    const patch = { id: m.id, x: m.x, y: m.y };
    if (mode === 'crop') patch.crop = m.crop ? { l: m.crop.l, t: m.crop.t, r: m.crop.r, b: m.crop.b } : null;
    else { patch.stretchX = m.stretchX || null; patch.stretchY = m.stretchY || null; }
    return patch;
  }

  // Режим обрезки: ручки тянут край обрезки вместо растяжения. Включается только для выбранной, доступной
  // и не заблокированной картинки; выбор другой картинки или закрытие режима картинок его выключает.
  function setImageCropMode(on) {
    let next = !!on;
    if (next) {
      const m = currentState && currentState.mapImages && currentState.mapImages.find((mi) => mi.id === selectedMapImageId);
      next = imageEditActive() && !!m && !m.locked && canEditImage(m);
    }
    if (next === imageCropMode) return;
    imageCropMode = next;
    imageGesture = null;
    draw();
    emitCropMode();
  }

  // Режим обрезки сменился: панели (кнопка «Обрезать») слушают document 'imagecrop:change' { on }.
  function emitCropMode() {
    document.dispatchEvent(new CustomEvent('imagecrop:change', { detail: { on: imageCropMode } }));
  }
  // Тихий выход из режима обрезки (выбор снят, режим картинок выключен) — без перерисовки: её делает вызывающий.
  function leaveCropMode() {
    if (!imageCropMode) return;
    imageCropMode = false;
    emitCropMode();
  }

  // Поле ввода, в которое сейчас печатают: горячие клавиши картинок его не трогают.
  function isTypingTarget(el) {
    if (!el) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    if (el.tagName !== 'INPUT') return false;
    return !['range', 'checkbox', 'radio', 'button', 'file', 'submit'].includes(el.type);
  }

  // Горячие клавиши карты молчат, если их уже обработали, идёт ввод в поле, открыта модалка или заставка локации.
  function keysBlocked(e) {
    if (e.defaultPrevented || e.isComposing) return true;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return true;
    return !!(document.querySelector('.modal-backdrop') || document.querySelector('.scene-intro-overlay.show'));
  }

  // Горячие клавиши выбранной картинки: Delete/Backspace — удалить, Ctrl/Cmd+D — дубликат, C — режим обрезки,
  // Enter/Esc — выйти из обрезки. Буквы — по физической клавише (event.code): на русской раскладке key = «в»/«с».
  // capture: раньше обработчика Esc у Dock (он пропускает уже обработанное — defaultPrevented).
  function onImageKeydown(e) {
    if (!imageEditActive() || !selectedMapImageId || keysBlocked(e)) return;
    const m = currentState && currentState.mapImages && currentState.mapImages.find((mi) => mi.id === selectedMapImageId);
    if (!m || !canEditImage(m)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if ((e.key === 'Delete' || e.key === 'Backspace') && !ctrl && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (mapImageActionHandler) mapImageActionHandler({ action: 'remove', id: m.id });
    } else if (ctrl && !e.altKey && !e.shiftKey && e.code === 'KeyD') {
      e.preventDefault(); // иначе браузер добавит страницу в закладки
      if (mapImageActionHandler) mapImageActionHandler({ action: 'duplicate', id: m.id });
    } else if (!ctrl && !e.altKey && !e.shiftKey && e.code === 'KeyC') {
      e.preventDefault();
      setImageCropMode(!imageCropMode);
    } else if (imageCropMode && (e.key === 'Enter' || e.key === 'Escape')) {
      e.preventDefault();
      setImageCropMode(false);
    }
  }
  document.addEventListener('keydown', onImageKeydown, true);

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
    else if (role === 'player' && fogSet.size) draw(); // вернулись — дымка снова идёт (draw запустит цикл)
  });

  // Анимация тумана игрока (public/js/fogfx.js): свой лёгкий цикл с троттлингом по fogFx.targetFps().
  // Время дымки берётся из performance.now(), поэтому кадр animLoop (эффекты, ходьба) продвигает её тоже —
  // тогда тик сам ничего не рисует. Цикл живёт, только пока последний кадр просит анимацию (есть полоса у
  // границы, включено, не reduced-motion, не «статично»), и не работает в фоновой вкладке.
  function ensureFogLoop() {
    if (fogRafId !== null || !fogAnimating || document.hidden) return;
    fogRafId = requestAnimationFrame(fogTick);
  }
  function fogTick(ts) {
    fogRafId = null;
    if (!fogAnimating || document.hidden || !window.fogFx) return;
    const fps = window.fogFx.targetFps();
    if (!fps) return;
    if (ts - fogLastTick < 1000 / fps - 3 || animRafId !== null) { fogRafId = requestAnimationFrame(fogTick); return; }
    fogLastTick = ts;
    const t0 = performance.now();
    draw(); // сам перезапустит цикл через ensureFogLoop
    window.fogFx.noteFrame(performance.now() - t0);
  }
  // Выключатель/режим fogFx сменился (личная настройка, reduced-motion, авто-упрощение) — перерисовать.
  document.addEventListener('fogfx:change', () => { if (role === 'player') draw(); });

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
      const { w, h } = imageBox(m);
      minX = Math.min(minX, m.x - w / 2);
      minY = Math.min(minY, m.y - h / 2);
      maxX = Math.max(maxX, m.x + w / 2);
      maxY = Math.max(maxY, m.y + h / 2);
    });
    const pad = FOG_FRAME_PAD_CELLS * currentState.map.cellSize;
    return {
      drawX: minX - pad,
      drawY: minY - pad,
      drawWidth: (maxX - minX) + pad * 2,
      drawHeight: (maxY - minY) + pad * 2,
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

  // Мировая точка → клетка сетки игры (абсолютный индекс, тот же, что у position
  // токенов): клетка (x,y) занимает x*cellSize … , y*cellSize + 20 … (см. drawGrid).
  function worldToCell(wx, wy) {
    const cellSize = currentState.map.cellSize;
    return { x: Math.floor(wx / cellSize), y: Math.floor((wy - 20) / cellSize) };
  }

  const fogKey = (x, y) => x + ',' + y;

  // Клетки по мировому прямоугольнику (границы включительно). Нужны «Скрыть всё»
  // и зоне: и то и другое красит все клетки, которых прямоугольник касается.
  function worldRectToCells(x0, y0, x1, y1) {
    const a = worldToCell(Math.min(x0, x1), Math.min(y0, y1));
    const b = worldToCell(Math.max(x0, x1), Math.max(y0, y1));
    return { i0: a.x, j0: a.y, i1: b.x, j1: b.y };
  }

  // Красит (hide) или открывает клетки прямоугольника { i0,j0,i1,j1 } (включительно).
  function paintCells(c, hide) {
    fogVer++;
    for (let j = c.j0; j <= c.j1; j++) {
      for (let i = c.i0; i <= c.i1; i++) {
        if (hide) fogSet.add(fogKey(i, j)); else fogSet.delete(fogKey(i, j));
      }
    }
  }

  // Заливает все клетки тумана внутри мирового прямоугольника (используется
  // только «Скрыть всё» — см. getKnownMapBounds).
  function fillFogRect(rect) {
    paintCells(worldRectToCells(rect.drawX, rect.drawY, rect.drawX + rect.drawWidth, rect.drawY + rect.drawHeight), true);
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

  // Формат blob v2: {"v":2,"runs":[[y,x0,x1],…]} — подряд идущие скрытые клетки
  // строки y одним отрезком x0…x1. Список «x,y» раздувал бы blob (сервер молча
  // отбрасывает всё больше FOG_MAX_SIZE), а «Скрыть всё» красит тысячи клеток.
  function getFogBlob() {
    // Всегда возвращаем валидную строку (даже пустой набор), а не null —
    // setFog() на сервере (typeof blob !== 'string') молча отбрасывает null,
    // из-за чего "Открыть все" не персистилось и туман возвращался после
    // перезагрузки страницы.
    const rows = new Map(); // y → [x…]
    fogSet.forEach((key) => {
      const [x, y] = key.split(',').map(Number);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(x);
    });
    const runs = [];
    Array.from(rows.keys()).sort((a, b) => a - b).forEach((y) => {
      const xs = rows.get(y).sort((a, b) => a - b);
      let start = xs[0];
      let prev = xs[0];
      for (let k = 1; k < xs.length; k++) {
        if (xs[k] === prev + 1) { prev = xs[k]; continue; }
        runs.push([y, start, prev]);
        start = xs[k];
        prev = xs[k];
      }
      runs.push([y, start, prev]);
    });
    return JSON.stringify({ v: 2, runs });
  }

  function applyFogBlob(blob) {
    fogVer++;
    fogSet.clear();
    if (blob) {
      try {
        const data = JSON.parse(blob);
        if (data && data.v === 2 && Array.isArray(data.runs)) {
          let total = 0;
          for (const run of data.runs) {
            if (!Array.isArray(run)) continue;
            const [y, x0, x1] = run;
            if (!Number.isInteger(y) || !Number.isInteger(x0) || !Number.isInteger(x1) || x1 < x0) continue;
            total += x1 - x0 + 1;
            if (total > FOG_MAX_CELLS) break;
            for (let x = x0; x <= x1; x++) fogSet.add(fogKey(x, y));
          }
        }
      } catch (e) {
        // Не JSON — как и прежние форматы («colsxrows:base64», массив «i,j» на сетке 24 px),
        // не читаем: туман просто сбрасывается.
      }
    }
    draw();
  }

  // Проверяет, скрыта ли мировая точка текущим туманом (для игрока).
  function isPositionFogged(wx, wy) {
    if (!fogSet.size) return false;
    const cell = worldToCell(wx, wy);
    return fogSet.has(fogKey(cell.x, cell.y));
  }

  // Клетки под квадратной кистью fogBrush×fogBrush, выровненной по сетке: нечётная
  // центрируется на клетке под указателем, чётная — на ближайшем узле сетки.
  // Единственный источник правды и для закраски, и для рамки-предпросмотра.
  function brushFootprint(sx, sy) {
    if (!currentState) return null;
    const cellSize = currentState.map.cellSize;
    const world = screenToWorld(sx, sy);
    const n = fogBrush;
    const start = (g) => (n % 2 ? Math.floor(g) - (n - 1) / 2 : Math.round(g) - n / 2);
    const i0 = start(world.x / cellSize);
    const j0 = start((world.y - 20) / cellSize);
    return { i0, j0, i1: i0 + n - 1, j1: j0 + n - 1 };
  }

  // Рамка клеток под кистью видна ГМ, пока мышь над картой в режиме «Кисть».
  function brushPreviewActive() {
    return role === 'gm' && fogEdit && fogTool === 'brush';
  }

  const sameCells = (a, b) => (!a && !b) || !!(a && b && a.i0 === b.i0 && a.j0 === b.j0 && a.i1 === b.i1 && a.j1 === b.j1);

  // Указатель переместился (pt в px канваса) или ушёл с карты (null): перерисовываем,
  // только если рамка сменила клетки.
  function setFogHoverPoint(pt) {
    fogHoverPt = pt;
    const next = pt && brushPreviewActive() ? brushFootprint(pt.x, pt.y) : null;
    if (!sameCells(next, fogHoverCells)) draw();
  }

  function paintBrushAt(sx, sy) {
    const cells = brushFootprint(sx, sy);
    if (!cells) return;
    paintCells(cells, fogHideNow());
    fogHoverPt = { x: sx, y: sy };
    draw();
  }

  // Клетки зоны: все, которых касается прямоугольник жеста. Та же функция рисует
  // маркизу, поэтому видимая рамка = закрашиваемое.
  function zoneCells(sel) {
    return worldRectToCells(sel.x0, sel.y0, sel.x1, sel.y1);
  }

  function applyZone(sel) {
    paintCells(zoneCells(sel), fogHideNow());
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
      imageGesture = null;
      leaveCropMode();
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
    const world = screenToWorld(sx, sy);
    return worldToCell(world.x, world.y);
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
      const handleHit = findImageResizeHandleAt(world.x, world.y);
      if (handleHit) return resizeCursorForAngle(handleHit.point.x - handleHit.m.x, handleHit.point.y - handleHit.m.y);
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
    setFogShift(e.shiftKey);
    const pt = eventToCanvasPoint(e);
    lastHoverPoint = pt;
    canvas.style.cursor = cursorForHover(pt.x, pt.y);
    setFogHoverPoint(pt);
  });

  canvas.addEventListener('mouseleave', () => {
    if (activePointers.size > 0) return; // жест с захватом указателя продолжается и за краем карты
    setFogHoverPoint(null);
  });

  // --- Клавиши и колесо инструментов «Туман» (только ГМ) и «Рисунок» (обе роли) ----------------------------
  // Работают, пока открыт блок инструмента (fogEdit / drawMode). Буквы и скобки — по event.code: на русской
  // раскладке key = «ч»/«х». Панели узнают о смене режима, размера и толщины по событиям document
  // 'fog:change' { hide, effective, brush } и 'draw:change' { tool, width }.
  //   Туман:   X — Скрыть ↔ Открыть, Shift (пока зажат) — обратный режим, [ ] и Ctrl+колесо — размер кисти.
  //   Рисунок: X — Перо ↔ Ластик, Ctrl+Z — отменить своё последнее действие, [ ] и Ctrl+колесо — толщина.
  // Во время жеста с нажатой кнопкой (штрих, ластик) инструмент и толщину не меняем: штрих ушёл бы не таким, как показан.

  // Режим кисти с учётом зажатого Shift: «Скрыть» с Shift стирает туман, «Открыть» с Shift — закрашивает.
  function fogHideNow() { return fogShiftHeld ? !fogHide : fogHide; }

  function emitFogChange() {
    document.dispatchEvent(new CustomEvent('fog:change', { detail: { hide: fogHide, effective: fogHideNow(), brush: fogBrush } }));
  }

  function emitDrawChange() {
    document.dispatchEvent(new CustomEvent('draw:change', { detail: { tool: drawTool, width: drawWidth } }));
  }

  function setFogHide(v) {
    const next = !!v;
    if (next === fogHide) return;
    fogHide = next;
    if (fogHoverPt) draw(); // рамка кисти меняет цвет
    emitFogChange();
  }

  // Размер кисти — сторона квадрата в клетках, 1…FOG_BRUSH_MAX (кисть всегда красит хотя бы клетку).
  function setFogBrush(n) {
    const next = clamp(Math.round(n) || 1, 1, FOG_BRUSH_MAX);
    if (next === fogBrush) return;
    fogBrush = next;
    if (fogHoverPt) draw();
    emitFogChange();
  }

  // Shift зажат или отпущен. Состояние держим всегда (не только в режиме тумана), панель и кадр обновляем только в нём.
  function setFogShift(held) {
    if (held === fogShiftHeld) return;
    fogShiftHeld = held;
    if (!fogEdit) return;
    if (fogHoverPt || fogSelection) draw();
    emitFogChange();
  }

  function setDrawTool(t) {
    const next = t === 'eraser' ? 'eraser' : 'pen';
    if (next === drawTool) return;
    drawTool = next;
    if (drawMode && lastHoverPoint) canvas.style.cursor = cursorForHover(lastHoverPoint.x, lastHoverPoint.y);
    emitDrawChange();
  }

  function setDrawWidth(n) {
    const next = clamp(Math.round(n) || 4, 1, 24);
    if (next === drawWidth) return;
    drawWidth = next;
    emitDrawChange();
  }

  const drawGestureActive = () => !!currentStroke || drawErasing;
  const stepDrawWidth = (delta) => setDrawWidth(clamp(drawWidth + delta, 1, DRAW_WIDTH_PANEL_MAX));

  function onToolKeydown(e) {
    const fogKeys = role === 'gm' && fogEdit;
    if (!fogKeys && !drawMode) return;
    if (keysBlocked(e)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) {
      // Ctrl/Cmd+Z — то же, что ПКМ в режиме рисования: сервер снимает последний штрих именно этого автора.
      if (!fogKeys && drawMode && !vfxPlaceMode && e.code === 'KeyZ' && !e.altKey && !e.shiftKey
          && !drawGestureActive() && drawUndoHandler) {
        e.preventDefault();
        drawUndoHandler();
      }
      return;
    }
    if (e.code === 'KeyX') {
      if (e.repeat) return; // удержание клавиши не должно мигать режимом
      if (fogKeys) setFogHide(!fogHide);
      else if (!drawGestureActive()) setDrawTool(drawTool === 'pen' ? 'eraser' : 'pen');
      else return;
      e.preventDefault();
    } else if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      const dir = e.code === 'BracketRight' ? 1 : -1;
      if (fogKeys) setFogBrush(fogBrush + dir);
      else if (!drawGestureActive()) stepDrawWidth(dir);
      else return;
      e.preventDefault();
    }
  }
  document.addEventListener('keydown', onToolKeydown, true);

  // Shift тянем в обе стороны: keyup может пропасть (окно потеряло фокус), поэтому ещё blur и сверка с событиями мыши.
  document.addEventListener('keydown', (e) => { if (e.key === 'Shift') setFogShift(true); }, true);
  document.addEventListener('keyup', (e) => { if (e.key === 'Shift') setFogShift(false); }, true);
  window.addEventListener('blur', () => setFogShift(false));

  // Ctrl/Cmd+колесо над картой: размер кисти тумана («Кисть») или толщина линии вместо зума. Копилка нужна, чтобы
  // тачпад с мелкими deltaY не «улетал», а щелчок мыши (≈100) давал ровно один шаг; вверх — больше, как у зума.
  // Возвращает true, если колесо отдано инструменту (зумить не нужно).
  let toolWheelAcc = 0;
  function toolWheel(e) {
    const brushOn = role === 'gm' && fogEdit && fogTool === 'brush';
    if (!brushOn && !drawMode) return false;
    if (!brushOn && drawGestureActive()) return true;
    const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
    if (toolWheelAcc * dy < 0) toolWheelAcc = 0; // направление сменилось
    toolWheelAcc += dy;
    if (Math.abs(toolWheelAcc) >= TOOL_WHEEL_STEP_PX) {
      const dir = toolWheelAcc < 0 ? 1 : -1;
      toolWheelAcc = 0;
      if (brushOn) setFogBrush(fogBrush + dir);
      else stepDrawWidth(dir);
    }
    return true;
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastPointerType = e.pointerType || 'mouse'; // от него зависит зона попадания по ручкам картинки
    if (activePointers.size === 1) {
      const isMouse = e.pointerType === 'mouse';
      // ГМ рисует туман: тач/перо или ЛКМ перехватывают жест под кисть/зону.
      if (role === 'gm' && fogEdit && (!isMouse || e.button === 0)) {
        setFogShift(e.shiftKey); // клавиша могла быть отпущена вне страницы
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
        const handleHit = findImageResizeHandleAt(world.x, world.y);
        if (handleHit) {
          const { m, kind, index, point } = handleHit;
          if (kind === 'corner' && !imageCropMode && !e.shiftKey) {
            // Угол без Shift — пропорциональный масштаб: противоположный угол остаётся неподвижным «якорем».
            const anchor = mapImageCorners(m)[(index + 2) % 4];
            imageResizing = {
              id: m.id,
              anchorX: anchor.x,
              anchorY: anchor.y,
              dirX: point.x - anchor.x,
              dirY: point.y - anchor.y,
              length0: Math.hypot(point.x - anchor.x, point.y - anchor.y),
              scale0: m.scale,
            };
            canvas.style.cursor = resizeCursorForAngle(point.x - anchor.x, point.y - anchor.y);
          } else {
            // Середина стороны, угол с Shift (растянуть как угодно) или любая ручка в режиме обрезки.
            startImageGesture(m, kind, index, imageCropMode ? 'crop' : 'stretch');
            canvas.style.cursor = resizeCursorForAngle(point.x - m.x, point.y - m.y);
          }
          return;
        }
        const hit = findMapImageAt(world.x, world.y);
        const prevSelected = selectedMapImageId;
        selectedMapImageId = hit ? hit.id : null;
        if (selectedMapImageId !== prevSelected && imageCropMode) setImageCropMode(false);
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
    // Рамка кисти следует за мышью и во время панорамирования (hover-обработчик на нажатой кнопке молчит).
    if (fogHoverPt && e.pointerType === 'mouse') fogHoverPt = eventToCanvasPoint(e);
    if (fogPainting && e.pointerType === 'mouse') setFogShift(e.shiftKey);

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

    if (imageGesture) {
      const pt = eventToCanvasPoint(e);
      const world = screenToWorld(pt.x, pt.y);
      const m = currentState && currentState.mapImages && currentState.mapImages.find((mi) => mi.id === imageGesture.id);
      if (m) {
        applyImageGesture(m, world);
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
    if (imageGesture) {
      const m = currentState && currentState.mapImages && currentState.mapImages.find((mi) => mi.id === imageGesture.id);
      const mode = imageGesture.mode;
      imageGesture = null;
      activePointers.delete(e.pointerId);
      if (m && mapImageUpdateHandler) mapImageUpdateHandler(imageGesturePatch(m, mode));
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
      fogHoverPt = e.pointerType === 'mouse' ? pt : null; // у тача после отпускания рамка не нужна
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
    if ((e.ctrlKey || e.metaKey) && toolWheel(e)) return;
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
  // ГМ сменил цвета игры (тема, цвета фракций — public/js/game.js): canvas читает токены сам, перечитываем и перерисовываем.
  document.addEventListener('theme:change', () => { readTheme(); draw(); });

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
        const { w, h, l, t, r, b } = imageBox(m);
        const angle = m.rotation || 0;
        // Обрезка хранится долями — применяем их к реальным размерам файла (а не к объявленным серверу):
        // без обрезки это весь файл, как и раньше. Растяжение уже учтено в w/h.
        const iw = img.naturalWidth || m.naturalWidth;
        const ih = img.naturalHeight || m.naturalHeight;
        // Поворот — через save/translate/rotate вокруг центра картинки, рисуем
        // от -w/2,-h/2 в повёрнутой системе координат.
        ctx.save();
        ctx.translate(m.x, m.y);
        ctx.rotate(angle);
        // Отражение — в системе координат самой картинки (после поворота): рамка и ручки не меняются.
        if (m.flipX || m.flipY) ctx.scale(m.flipX ? -1 : 1, m.flipY ? -1 : 1);
        ctx.drawImage(img, iw * l, ih * t, iw * (1 - l - r), ih * (1 - t - b), -w / 2, -h / 2, w, h);
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
    // У игрока туман «живой» (public/js/fogfx.js: мягкие края и дымка вдоль границы); без fogFx — прежние
    // квадраты. У ГМ — всегда квадраты со штриховкой: ему нужна точная правка по клеткам.
    fogAnimating = false;
    if (fogSet.size) {
      const fogCell = currentState.map.cellSize;
      const useFx = role === 'player' && !!window.fogFx && window.fogFx.available;
      // fogFx считает размытие по окну клеток — запас шире, чтобы граница за краем экрана ещё давала дымку.
      const pad = useFx ? FOG_FX_MARGIN_CELLS : 1;
      const viewMin = screenToWorld(0, 0);
      const viewMax = screenToWorld(canvas.width, canvas.height);
      const i0 = Math.floor(viewMin.x / fogCell) - pad;
      const j0 = Math.floor((viewMin.y - 20) / fogCell) - pad;
      const i1 = Math.floor(viewMax.x / fogCell) + pad;
      const j1 = Math.floor((viewMax.y - 20) / fogCell) + pad;
      if (useFx) {
        const gridW = i1 - i0 + 1;
        const gridH = j1 - j0 + 1;
        const key = `${i0}|${j0}|${gridW}|${gridH}|${fogCell}|${fogVer}`;
        const dirty = key !== fogGridKey;
        if (dirty) {
          if (fogGrid.length < gridW * gridH) fogGrid = new Uint8Array(gridW * gridH);
          for (let j = j0; j <= j1; j++) {
            const row = (j - j0) * gridW - i0;
            for (let i = i0; i <= i1; i++) fogGrid[row + i] = fogSet.has(fogKey(i, j)) ? 1 : 0;
          }
          fogGridKey = key;
        }
        const res = window.fogFx.draw(ctx, {
          cells: fogGrid, gridW, gridH, i0, j0, cellSize: fogCell, yOff: 20,
          cam: camera, w: canvas.width, h: canvas.height, theme: THEME, now: performance.now(), dirty,
        });
        fogAnimating = !!res.animating;
      } else {
        // Клетки собираем одним path'ом (rect+fill), а не отдельными fillRect —
        // иначе на стыках соседних клеток при дробном зуме остаются тонкие
        // щели (каждый fillRect сглаживается по краю независимо от соседа).
        // Те же клетки, что и в сетке: (i,j) → i*cellSize, j*cellSize + 20.
        const fogPath = new Path2D();
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            if (fogSet.has(fogKey(i, j))) fogPath.rect(i * fogCell, j * fogCell + 20, fogCell, fogCell);
          }
        }
        ctx.fillStyle = role === 'gm' ? 'rgba(12,14,20,0.7)' : THEME.bg;
        ctx.fill(fogPath);
        if (role === 'gm') {
          ctx.fillStyle = getFogHatchPattern(ctx);
          ctx.fill(fogPath);
        }
      }
    }
    ensureFogLoop();

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
        // Аватар любых пропорций (в том числе положенный в папку руками) — обрезка до квадрата:
        // по горизонтали центр, по вертикали чуть выше центра (лица), иначе картинка сплющилась бы.
        const iw = avatarImg.naturalWidth || avatarImg.width;
        const ih = avatarImg.naturalHeight || avatarImg.height;
        if (iw > 0 && ih > 0) {
          const side = Math.min(iw, ih);
          ctx.drawImage(avatarImg, (iw - side) / 2, (ih - side) * 0.25, side, side, cx - r, cy - r, r * 2, r * 2);
        } else {
          ctx.drawImage(avatarImg, cx - r, cy - r, r * 2, r * 2);
        }
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
        const box = imageBox(m);
        const { w, h } = box;
        const angle = m.rotation || 0;
        const cropping = imageCropMode && !m.locked;
        const frameColor = m.locked ? THEME.danger : (cropping ? THEME.amber : THEME.accent);
        // Режим обрезки: полная картинка бледной подложкой за видимой частью — видно, что отрезано, и обрезанное
        // можно вернуть, потянув ручку наружу. Рисуется в тех же осях, что и сама картинка (поворот, отражение).
        if (cropping) {
          const img = getAvatarImage(m.url, draw);
          if (img) {
            const fullW = m.naturalWidth * box.kx;
            const fullH = m.naturalHeight * box.ky;
            const offX = (m.naturalWidth * (box.r - box.l) / 2) * box.kx; // центр полной картинки относительно видимой части
            const offY = (m.naturalHeight * (box.b - box.t) / 2) * box.ky;
            ctx.save();
            ctx.translate(m.x, m.y);
            ctx.rotate(angle);
            if (m.flipX || m.flipY) ctx.scale(m.flipX ? -1 : 1, m.flipY ? -1 : 1);
            ctx.globalAlpha = 0.35;
            ctx.drawImage(img, 0, 0, img.naturalWidth || m.naturalWidth, img.naturalHeight || m.naturalHeight, -fullW / 2 + offX, -fullH / 2 + offY, fullW, fullH);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = frameColor;
            ctx.lineWidth = 1 / camera.zoom;
            ctx.setLineDash([2 / camera.zoom, 3 / camera.zoom]);
            ctx.strokeRect(-fullW / 2 + offX, -fullH / 2 + offY, fullW, fullH);
            ctx.restore();
          }
        }
        ctx.save();
        ctx.translate(m.x, m.y);
        ctx.rotate(angle);
        ctx.strokeStyle = frameColor;
        ctx.lineWidth = 2 / camera.zoom;
        ctx.setLineDash([6 / camera.zoom, 4 / camera.zoom]);
        ctx.strokeRect(-w / 2, -h / 2, w, h);
        ctx.restore();
        if (!m.locked) {
          const visualRadius = IMAGE_HANDLE_RADIUS * (lastPointerType === 'mouse' ? 1 : 1.5);
          const handleSize = (visualRadius * 2) / camera.zoom;
          ctx.save();
          ctx.fillStyle = cropping ? THEME.amber : THEME.accent;
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5 / camera.zoom;
          mapImageCorners(m).forEach((c) => {
            ctx.fillRect(c.x - handleSize / 2, c.y - handleSize / 2, handleSize, handleSize);
            ctx.strokeRect(c.x - handleSize / 2, c.y - handleSize / 2, handleSize, handleSize);
          });
          // Середины сторон: вытянутые планки вдоль стороны (растяжение в одну сторону / край обрезки).
          mapImageEdgeMids(m).forEach((c, i) => {
            const barW = handleSize * (i % 2 === 0 ? 1.25 : 0.55);
            const barH = handleSize * (i % 2 === 0 ? 0.55 : 1.25);
            ctx.save();
            ctx.translate(c.x, c.y);
            ctx.rotate(angle);
            ctx.fillRect(-barW / 2, -barH / 2, barW, barH);
            ctx.strokeRect(-barW / 2, -barH / 2, barW, barH);
            ctx.restore();
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

    // Маркиза зоны тумана (пунктир, пока ГМ тянет прямоугольник) и рамка клеток под
    // кистью — обе по клеткам сетки, ровно по тому, что будет закрашено.
    fogHoverCells = fogHoverPt && brushPreviewActive() ? brushFootprint(fogHoverPt.x, fogHoverPt.y) : null;
    const fogMarks = fogSelection ? zoneCells(fogSelection) : fogHoverCells;
    if (fogMarks) {
      const cs = currentState.map.cellSize;
      const x = fogMarks.i0 * cs;
      const y = fogMarks.j0 * cs + 20;
      const w = (fogMarks.i1 - fogMarks.i0 + 1) * cs;
      const h = (fogMarks.j1 - fogMarks.j0 + 1) * cs;
      ctx.save();
      const hiding = fogHideNow();
      ctx.fillStyle = hiding ? 'rgba(255,90,90,0.16)' : 'rgba(120,200,255,0.16)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = hiding ? 'rgba(255,90,90,0.95)' : 'rgba(120,200,255,0.95)';
      ctx.lineWidth = 2 / camera.zoom;
      if (fogSelection) ctx.setLineDash([6 / camera.zoom, 4 / camera.zoom]);
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
    setFogEditMode: (v) => { fogEdit = !!v; if (fogEdit && role === 'gm') clearSelection(); if (!fogEdit) { fogSelection = null; fogPainting = false; fogHoverPt = null; } draw(); if (lastHoverPoint) canvas.style.cursor = cursorForHover(lastHoverPoint.x, lastHoverPoint.y); },
    setFogTool: (t) => { fogTool = t === 'zone' ? 'zone' : 'brush'; draw(); },
    setFogHide,
    setFogBrush,
    revealAllFog: () => { fogVer++; fogSet.clear(); draw(); if (fogChangeHandler) fogChangeHandler(getFogBlob()); },
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
    setImageEditMode: (v) => { imageEdit = !!v; if (imageEdit && role === 'gm') clearSelection(); if (!imageEdit) { imageDragging = null; imageResizing = null; imageRotating = null; imageGesture = null; leaveCropMode(); selectedMapImageId = null; if (mapImageSelectHandler) mapImageSelectHandler(null); } draw(); if (lastHoverPoint) canvas.style.cursor = cursorForHover(lastHoverPoint.x, lastHoverPoint.y); },
    // Видимый размер мира в мировых px — для подбора начального масштаба вставляемой картинки.
    getViewSize: () => ({ w: canvas.width / camera.zoom, h: canvas.height / camera.zoom }),
    // Для слоя погоды (public/js/weather.js): камера и размер холста — перевод мира в экран
    // (sx = w/2 + (x - cam.x) * zoom) — и углы картинок в мировых координатах, чтобы вырезать
    // погоду под каждой картинкой (с учётом поворота; отражение прямоугольник не меняет).
    getView: () => ({ x: camera.x, y: camera.y, zoom: camera.zoom, w: canvas.width, h: canvas.height }),
    getImageQuads: () => ((currentState && currentState.mapImages) || []).map(mapImageCorners),
    setMapImageSelectHandler: (fn) => { mapImageSelectHandler = fn; },
    setMapImageUpdateHandler: (fn) => { mapImageUpdateHandler = fn; },
    // Выбор картинки программно (из панели, после дубликата): панель узнаёт о нём тем же колбэком, что и о клике по карте.
    selectMapImage: (id) => {
      const prev = selectedMapImageId;
      selectedMapImageId = id;
      if (id !== prev && imageCropMode) setImageCropMode(false);
      draw();
      if (id !== prev && mapImageSelectHandler) mapImageSelectHandler(selectedMapImageId);
    },
    setMapImageActionHandler: (fn) => { mapImageActionHandler = fn; },
    setImageCropMode,
    isImageCropMode: () => imageCropMode,
    getSelectedMapImageId: () => selectedMapImageId,
    setDrawMode: (v) => { drawMode = !!v; if (drawMode && role === 'gm') clearSelection(); if (!drawMode) { currentStroke = null; drawErasing = false; erasedThisGesture = null; } draw(); if (lastHoverPoint) canvas.style.cursor = cursorForHover(lastHoverPoint.x, lastHoverPoint.y); },
    setDrawTool,
    setDrawWidth,
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
