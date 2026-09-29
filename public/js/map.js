// NPC не имеют персональных цветов (их слишком много и они не «постоянные
// герои» партии) — используем единый оттенок, совпадающий с .bar-fill.npc в CSS.
const NPC_COLOR = '#c05656';

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

  // Топовая (последняя в массиве) картинка под мировой точкой, или null.
  // Точка переводится в локальные (неповёрнутые) координаты картинки поворотом
  // на -rotation вокруг центра — дальше обычная проверка axis-aligned прямоугольника.
  function findMapImageAt(wx, wy) {
    if (!currentState || !currentState.mapImages) return null;
    const list = currentState.mapImages;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
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
    if (!m || m.locked) return null;
    const p = rotateHandlePosition(m);
    const radius = IMAGE_HANDLE_RADIUS / camera.zoom;
    return Math.hypot(wx - p.x, wy - p.y) <= radius ? m : null;
  }

  // Угловая ручка выбранной картинки под мировой точкой (для масштабирования
  // перетаскиванием) — проверяется только у уже выбранной картинки.
  function findMapImageHandleAt(wx, wy) {
    if (!currentState || !currentState.mapImages || !selectedMapImageId) return null;
    const m = currentState.mapImages.find((mi) => mi.id === selectedMapImageId);
    if (!m || m.locked) return null;
    const corners = mapImageCorners(m);
    const radius = IMAGE_HANDLE_RADIUS / camera.zoom;
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

  // --- Спецэффекты (дым/огонь/фейерверк) -----------------------------------
  // vfxPlaceMode — как drawMode, доступен ОБЕИМ ролям, но НЕ гасится после
  // одного клика (можно поставить несколько эффектов подряд) — выключается
  // повторным нажатием той же кнопки в EffectsPanel.vue.
  let vfxPlaceMode = null;   // null | 'smoke' | 'fire' | 'firework'
  let vfxPlaceHandler = null;
  let activeEffects = [];    // [{ type, x, y, startedAt, duration }] — только в памяти, не персистится
  let vfxRafId = null;
  const VFX_DURATION = { smoke: 2200, fire: 1800, firework: 1200 };

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
    if (vfxRafId === null) vfxLoop();
  }

  function vfxLoop() {
    const now = performance.now();
    activeEffects = activeEffects.filter((fx) => now - fx.startedAt < fx.duration);
    draw();
    vfxRafId = activeEffects.length ? requestAnimationFrame(vfxLoop) : null;
  }

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
  // Диапазон линий ограничен и видимым вьюпортом, и границами карты, чтобы
  // не рисовать тысячи линий на сетке 1000x500.
  const GRID_COLOR = 'rgba(255,255,255,0.1)';
  function drawGrid() {
    if (!currentState || !currentState.map) return;
    const { cellSize, gridWidth, gridHeight } = currentState.map;
    const viewMin = screenToWorld(0, 0);
    const viewMax = screenToWorld(canvas.width, canvas.height);
    const yOff = 20;
    const i0 = Math.max(0, Math.floor(viewMin.x / cellSize) - 1);
    const i1 = Math.min(gridWidth, Math.ceil(viewMax.x / cellSize) + 1);
    const j0 = Math.max(0, Math.floor((viewMin.y - yOff) / cellSize) - 1);
    const j1 = Math.min(gridHeight, Math.ceil((viewMax.y - yOff) / cellSize) + 1);
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

  function clampCamera() {
    if (!currentState || !currentState.map) return;
    const layout = currentState.map;
    const contentW = layout.gridWidth * layout.cellSize;
    const contentH = layout.gridHeight * layout.cellSize + 20;
    const margin = 260;
    camera.x = clamp(camera.x, -margin, contentW + margin);
    camera.y = clamp(camera.y, -margin, contentH + margin);
  }

  function updateState(state) {
    // Смена активной локации — камера прежней локации тут не годится
    // (другой размер сетки), поэтому переинициализируем её для новой.
    const locationChanged = currentState && currentState.activeLocationId !== state.activeLocationId;
    currentState = state;
    combatActive = !!(state && state.combat && state.combat.active);
    if (role !== 'gm' && state && state.characters) {
      const me = state.characters.find((c) => c.id === myCharacterId);
      if (me && me.color) drawColor = me.color;
    }
    if (locationChanged) cameraInitialized = false;
    if (!cameraInitialized && state && state.map) {
      initCamera();
      cameraInitialized = true;
    }
    draw();
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

  function handleTap(sx, sy) {
    if (!currentState) return;
    const { x, y } = cellFromCanvasPoint(sx, sy);

    const clickedCharacter = currentState.characters.find(
      (c) => c.position.x === x && c.position.y === y
    );
    if (clickedCharacter && (role === 'gm' || clickedCharacter.id === myCharacterId)) {
      selectTarget('character', clickedCharacter.id);
      return;
    }

    // NPC выбираются и перемещаются только мастером — игроки их вообще не видят.
    const clickedNpc = role === 'gm' && currentState.npcs
      ? currentState.npcs.find((n) => n.position && n.locationId === currentState.activeLocationId && n.position.x === x && n.position.y === y)
      : null;
    if (clickedNpc) {
      selectTarget('npc', clickedNpc.id);
      return;
    }

    if (!selectedTarget) return;

    if (role === 'gm') {
      if (moveHandler) moveHandler(selectedTarget, x, y);
      return;
    }

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

    if (role === 'gm' && imageEdit) {
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
      if (role === 'player' && combatActive && !reachableCells.has(`${x},${y}`)) return 'not-allowed';
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
      // ГМ в режиме редактирования картинок: сначала проверяем угловую ручку
      // выбранной картинки (масштабирование), иначе — захват/выбор картинки под точкой.
      if (role === 'gm' && imageEdit && (!isMouse || e.button === 0)) {
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
        if (hit && !hit.locked) {
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

  function draw() {
    ensureCanvasSize();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0a0b0f';
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
        if (role === 'gm' && imageEdit && selectedMapImageId === m.id) {
          ctx.strokeStyle = m.locked ? '#d86a5a' : '#5a7bd8';
          ctx.lineWidth = 2 / camera.zoom;
          ctx.setLineDash([6 / camera.zoom, 4 / camera.zoom]);
          ctx.strokeRect(-w / 2, -h / 2, w, h);
        }
        ctx.restore();
        if (role === 'gm' && imageEdit && selectedMapImageId === m.id && !m.locked) {
          const handleSize = (IMAGE_HANDLE_RADIUS * 2) / camera.zoom;
          ctx.save();
          ctx.fillStyle = '#5a7bd8';
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
          ctx.strokeStyle = '#5a7bd8';
          ctx.lineWidth = 1.5 / camera.zoom;
          ctx.beginPath();
          ctx.moveTo(topCenter.x, topCenter.y);
          ctx.lineTo(rp.x, rp.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(rp.x, rp.y, IMAGE_HANDLE_RADIUS / camera.zoom, 0, Math.PI * 2);
          ctx.fillStyle = '#5a7bd8';
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.stroke();
          ctx.restore();
        }
      });
    }

    // Сетка — поверх картинок (для ориентирования по клеткам всегда должна
    // быть видна), но под туманом/reachable-подсветкой/токенами.
    drawGrid();

    const cellInset = Math.max(1, cellSize * 0.05);
    reachableCells.forEach((cost, key) => {
      const [x, y] = key.split(',').map(Number);
      ctx.fillStyle = 'rgba(76, 175, 111, 0.1)';
      ctx.fillRect(x * cellSize + cellInset, y * cellSize + 20 + cellInset, cellSize - cellInset * 2, cellSize - cellInset * 2);
    });

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
      ctx.fillStyle = role === 'gm' ? 'rgba(12,14,20,0.7)' : '#0a0b0f';
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

    // Отрисовывает один токен (персонаж или NPC) — аватар/буква-заглушка + подпись.
    function drawToken(entity, isSelected, fallbackColor, labelLines, isDead) {
      const cx = (entity.position.x + 0.5) * cellSize;
      const cy = (entity.position.y + 0.5) * cellSize + 20;
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
        ctx.lineWidth = (isSelected ? 3 : 2) / camera.zoom;
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
        ctx.font = `bold ${cellSize * 0.3}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(entity.name[0], cx, cy);
        ctx.textBaseline = 'alphabetic';
      }

      // Крестик поверх иконки — NPC отмечен мастером как убитый.
      if (isDead) {
        ctx.save();
        ctx.lineWidth = Math.max(2, cellSize * 0.05) / camera.zoom;
        ctx.strokeStyle = '#e05252';
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
      ctx.font = `bold ${cellSize * 0.275}px system-ui`;
      ctx.textAlign = 'center';
      ctx.lineWidth = Math.max(1, cellSize * 0.075) / camera.zoom;
      ctx.strokeStyle = 'rgba(10, 11, 15, 0.85)';
      ctx.fillStyle = '#e8e8e8';
      labelLines.slice().reverse().forEach((line, i) => {
        const y = cy - r - cellSize * 0.1 - i * lineHeight;
        ctx.strokeText(line, cx, y);
        ctx.fillText(line, cx, y);
      });
    }

    currentState.characters.forEach((c) => {
      const isSelected = selectedTarget?.type === 'character' && selectedTarget.id === c.id;
      // Роль/имя персонажа сверху, а под ним — имя, введённое игроком при входе.
      const labelLines = c.claimedBy ? [c.name, c.claimedBy] : [c.name];
      drawToken(c, isSelected, c.color || '#888', labelLines, c.dead);
    });

    // NPC: игрокам сервер уже присылает только видимые (см. getPublicState),
    // мастеру — всех. Выбирать/двигать NPC может только мастер (см. handleTap).
    if (currentState.npcs) {
      currentState.npcs.filter((n) => n.position && n.locationId === currentState.activeLocationId).forEach((n) => {
        const cx = (n.position.x + 0.5) * cellSize;
        const cy = (n.position.y + 0.5) * cellSize + 20;
        // Игроку NPC под туманом не рисуется вообще — тайна тумана войны.
        if (role === 'player' && isPositionFogged(cx, cy)) return;
        const isSelected = selectedTarget?.type === 'npc' && selectedTarget.id === n.id;
        // Полупрозрачность у мастера — подсказка, что NPC ещё скрыт от игроков.
        if (role === 'gm' && !n.visible) ctx.globalAlpha = 0.45;
        drawToken(n, isSelected, NPC_COLOR, [n.name], n.dead);
        ctx.globalAlpha = 1;
      });
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
    setReachable,
    selectTarget,
    setMoveHandler,
    setSelectHandler,
    getSelectedTarget: () => selectedTarget,
    setFogEditMode: (v) => { fogEdit = !!v; if (!fogEdit) { fogSelection = null; fogPainting = false; } draw(); if (lastHoverPoint) canvas.style.cursor = cursorForHover(lastHoverPoint.x, lastHoverPoint.y); },
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
    setImageEditMode: (v) => { imageEdit = !!v; if (!imageEdit) { imageDragging = null; selectedMapImageId = null; if (mapImageSelectHandler) mapImageSelectHandler(null); } draw(); if (lastHoverPoint) canvas.style.cursor = cursorForHover(lastHoverPoint.x, lastHoverPoint.y); },
    setMapImageSelectHandler: (fn) => { mapImageSelectHandler = fn; },
    setMapImageUpdateHandler: (fn) => { mapImageUpdateHandler = fn; },
    selectMapImage: (id) => { selectedMapImageId = id; draw(); },
    getSelectedMapImageId: () => selectedMapImageId,
    setDrawMode: (v) => { drawMode = !!v; if (!drawMode) { currentStroke = null; drawErasing = false; erasedThisGesture = null; } draw(); if (lastHoverPoint) canvas.style.cursor = cursorForHover(lastHoverPoint.x, lastHoverPoint.y); },
    setDrawTool: (t) => { drawTool = t === 'eraser' ? 'eraser' : 'pen'; },
    setDrawWidth: (n) => { drawWidth = clamp(Math.round(n) || 4, 1, 24); },
    setDrawAddHandler: (fn) => { drawAddHandler = fn; },
    setDrawEraseHandler: (fn) => { drawEraseHandler = fn; },
    getMyDrawColor: () => drawColor,
    setVfxPlaceMode: (type) => { vfxPlaceMode = type || null; if (lastHoverPoint) canvas.style.cursor = cursorForHover(lastHoverPoint.x, lastHoverPoint.y); },
    setVfxPlaceHandler: (fn) => { vfxPlaceHandler = fn; },
    playEffect,
  };
}

window.createMapController = createMapController;
