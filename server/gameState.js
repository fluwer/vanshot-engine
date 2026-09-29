const fs = require('fs');
const path = require('path');
const map = require('./map');
const config = require('./config');

const DATA_DIR = path.join(__dirname, 'data');
const AVATARS_FILE = path.join(DATA_DIR, 'avatars.json');
const CODES_FILE = path.join(DATA_DIR, 'characterCodes.json');
const NPCS_FILE = path.join(DATA_DIR, 'npcs.json');
const FOG_FILE = path.join(DATA_DIR, 'fog.json');
const LOCATIONS_FILE = path.join(DATA_DIR, 'locations.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'avatars', 'uploads');

const characters = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'characters.json'), 'utf-8'));
const npcs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'npcs.json'), 'utf-8'));
const skillsCatalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'skills.json'), 'utf-8'));
const avatarAssignments = JSON.parse(fs.readFileSync(AVATARS_FILE, 'utf-8'));

// Код доступа к персонажу — защищает от того, что любой игрок войдёт под
// чужим героем и увидит/сломает его данные. Хранится отдельно от
// characters.json (как avatars.json), генерируется один раз при первом
// запуске для каждого персонажа, у которого ещё нет кода.
let characterCodes = {};
try {
  if (fs.existsSync(CODES_FILE)) {
    characterCodes = JSON.parse(fs.readFileSync(CODES_FILE, 'utf-8'));
  }
} catch (err) {
  console.error('Не удалось загрузить characterCodes.json:', err.message);
}

function generateCode() {
  // 6 цифр — достаточно, чтобы не подобрать случайно, и легко продиктовать/ввести.
  return String(Math.floor(config.CHARACTER_CODE_MIN + Math.random() * config.CHARACTER_CODE_RANGE));
}

function saveCharacterCodes() {
  try {
    fs.writeFileSync(CODES_FILE, JSON.stringify(characterCodes, null, 2));
  } catch (err) {
    console.warn('Не удалось сохранить characterCodes.json:', err.message);
  }
}

let codesChanged = false;
characters.forEach((c) => {
  if (!characterCodes[c.id]) {
    characterCodes[c.id] = generateCode();
    codesChanged = true;
  }
});
if (codesChanged) saveCharacterCodes();

// Локации — ГМ создаёт их прямо по ходу игры (не конфиг-файлом). При первом
// запуске (нет locations.json) создаём одну дефолтную локацию — то же место,
// где раньше был единственный глобальный поезд, но теперь пустая сетка.
let locations;
try {
  locations = JSON.parse(fs.readFileSync(LOCATIONS_FILE, 'utf-8'));
  if (!Array.isArray(locations) || !locations.length) throw new Error('empty locations.json');
} catch (err) {
  locations = [{
    id: 'train',
    name: 'Поезд',
    gridWidth: config.DEFAULT_LOCATION_WIDTH,
    gridHeight: config.DEFAULT_LOCATION_HEIGHT,
  }];
}

function saveLocations() {
  try {
    fs.writeFileSync(LOCATIONS_FILE, JSON.stringify(locations, null, 2));
  } catch (err) {
    console.warn('Не удалось сохранить locations.json:', err.message);
  }
}
if (!fs.existsSync(LOCATIONS_FILE)) saveLocations();

function findLocation(id) {
  return locations.find((l) => l.id === id);
}

function getActiveLocation() {
  return findLocation(state.activeLocationId) || locations[0];
}

function getActiveLocationLayout() {
  const l = getActiveLocation();
  return { cellSize: config.CELL_SIZE, gridWidth: l.gridWidth, gridHeight: l.gridHeight };
}

// Туман войны — теперь per-локация: { [locationId]: blob }. Старый формат
// ({blob: string}) — с одной глобальной картой — отбрасывается без миграции
// (см. CLAUDE.md про отсутствие миграций в этом соло-проекте).
let initialFog = null;
try {
  if (fs.existsSync(FOG_FILE)) {
    const raw = JSON.parse(fs.readFileSync(FOG_FILE, 'utf-8'));
    if (raw && typeof raw.blob !== 'string') initialFog = raw;
  }
} catch (err) {
  console.error('Не удалось загрузить fog.json:', err.message);
}

let initialChat = [];
try {
  if (fs.existsSync(CHAT_FILE)) {
    initialChat = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf-8'));
  }
} catch (err) {
  console.error('Не удалось загрузить chat.json:', err.message);
}

let initialRuntime = null;
try {
  if (fs.existsSync(RUNTIME_FILE)) {
    initialRuntime = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf-8'));
  }
} catch (err) {
  console.error('Не удалось загрузить runtime.json:', err.message);
}

const state = {
  currentDc: initialRuntime && initialRuntime.currentDc != null ? initialRuntime.currentDc : null,
  diceLog: (initialRuntime && initialRuntime.diceLog) || [],
  fog: initialFog || {},
  // Активная локация — одна на всех сразу (без независимых локаций у
  // разных игроков), переключается только ГМ (см. setActiveLocation).
  activeLocationId: (initialRuntime && initialRuntime.activeLocationId && findLocation(initialRuntime.activeLocationId))
    ? initialRuntime.activeLocationId
    : locations[0].id,
  chat: initialChat,
  // Боевой режим: включается/выключается мастером вручную. order — порядок
  // хода по инициативе (d20+Тело), currentIndex — чей сейчас ход. Персистится
  // в runtime.json (см. persistRuntimeState), чтобы пережить перезапуск сервера.
  combat: (initialRuntime && initialRuntime.combat) || { active: false, round: 0, order: [], currentIndex: 0 },
  // Картинки, которые мастер накладывает на карту (хендауты/доп. арт/фон —
  // движок своего фона не задаёт, мастер размещает всё сам). x/y — центр в
  // мировых px, naturalWidth/naturalHeight — реальный размер загруженного
  // файла, scale — множитель отображаемого размера.
  mapImages: (initialRuntime && initialRuntime.mapImages) || [],
  // Свободные рисунки (перо/ластик) от ГМ и игроков поверх карты — см. addDrawing.
  // points — мировые px (как x/y у mapImages), не привязаны к клеткам сетки.
  drawings: (initialRuntime && initialRuntime.drawings) || [],
  // Музыка: мастер выбирает трек и играет/ставит на паузу/останавливает —
  // общее для всех состояние (см. setMusicTrack/playMusic/pauseMusic/stopMusic).
  // startedAt — момент (Date.now()), от которого считается позиция в треке
  // (виртуальный старт, сдвинутый на pausedAt при возобновлении — см. playMusic),
  // pausedAt — позиция в секундах на момент постановки на паузу/остановки.
  // Громкость — чисто клиентская настройка, сюда не входит.
  music: (initialRuntime && initialRuntime.music) || { trackId: null, playing: false, startedAt: null, pausedAt: 0 },
};

// Все персонажи стартуют по центру активной локации (пустая сетка без
// именованных комнат) — ГМ вручную расставляет их дальше по сюжету через
// force-move.
let spawnOffset = 0;

characters.forEach((c) => {
  c.claimedBy = null;
  c.socketId = null;
  c.avatar = avatarAssignments[c.id] || null;
  c.code = characterCodes[c.id];
  c.armor = 0;
  c.dead = false;
  c.position = map.defaultSpawn(getActiveLocation(), spawnOffset);
  c.locationPositions = {};
  spawnOffset += 1;
});

// Восстанавливаем сохранённые ресурсы/позицию персонажей поверх дефолтного
// спауна (см. persistRuntimeState) — только для тех, у кого есть снимок.
if (initialRuntime && initialRuntime.characters) {
  characters.forEach((c) => {
    const saved = initialRuntime.characters[c.id];
    if (!saved) return;
    if (saved.hp != null) c.hp.current = saved.hp;
    if (saved.energy != null) c.energy.current = saved.energy;
    if (saved.resolve != null) c.resolve.current = saved.resolve;
    if (typeof saved.armor === 'number') c.armor = saved.armor;
    if (typeof saved.dead === 'boolean') c.dead = saved.dead;
    if (saved.position) c.position = saved.position;
    c.locationPositions = saved.locationPositions || {};
  });
}

npcs.forEach((n) => {
  if (typeof n.armor !== 'number') n.armor = 0;
  // По умолчанию NPC скрыты от игроков — мастер включает видимость вручную.
  if (typeof n.visible !== 'boolean') n.visible = false;
  if (typeof n.dead !== 'boolean') n.dead = false;
  // Старые npcs.json без locationId (или с указанием на удалённую локацию) —
  // привязываем к первой доступной локации, без ручной миграции.
  if (n.locationId === undefined || !findLocation(n.locationId)) n.locationId = locations[0].id;
});

// Восстанавливаем сохранённые ресурсы/позицию NPC поверх дефолтов из
// npcs.json (см. persistRuntimeState) — visible/dead/avatar сюда не входят,
// они персистятся отдельно прямо в npcs.json.
if (initialRuntime && initialRuntime.npcs) {
  npcs.forEach((n) => {
    const saved = initialRuntime.npcs[n.id];
    if (!saved) return;
    if (saved.hp != null) n.hp.current = saved.hp;
    if (saved.energy != null) n.energy.current = saved.energy;
    if (typeof saved.armor === 'number') n.armor = saved.armor;
    if (saved.position) n.position = saved.position;
  });
}

function findCharacter(id) {
  return characters.find((c) => c.id === id);
}

function findNpc(id) {
  return npcs.find((n) => n.id === id);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Проверяет код доступа перед тем, как позволить игроку зайти под персонажем.
function verifyCharacterCode(characterId, code) {
  const expected = characterCodes[characterId];
  if (!expected) return false;
  return String(code || '').trim() === expected;
}

// ГМ может в любой момент перегенерировать код персонажа (например, если
// код "спалился" и его нужно раздать заново).
function regenerateCharacterCode(characterId) {
  const c = findCharacter(characterId);
  if (!c) return null;
  const newCode = generateCode();
  characterCodes[characterId] = newCode;
  c.code = newCode;
  saveCharacterCodes();
  return newCode;
}

function claimCharacter(characterId, playerName, socketId) {
  const character = findCharacter(characterId);
  if (!character) return;
  releaseSocket(socketId);
  character.claimedBy = playerName;
  character.socketId = socketId;
}

function releaseSocket(socketId) {
  characters.forEach((c) => {
    if (c.socketId === socketId) {
      c.claimedBy = null;
      c.socketId = null;
    }
  });
}

function adjustCharacterHp(characterId, delta) {
  const c = findCharacter(characterId);
  if (!c) return;
  c.hp.current = clamp(c.hp.current + delta, 0, c.hp.max);
}

function adjustResolve(characterId, delta) {
  const c = findCharacter(characterId);
  if (!c) return;
  c.resolve.current = clamp(c.resolve.current + delta, 0, c.resolve.max);
}

function adjustNpcHp(npcId, delta) {
  const n = findNpc(npcId);
  if (!n) return;
  n.hp.current = clamp(n.hp.current + delta, 0, n.hp.max);
}

function adjustEnergy(characterId, delta) {
  const c = findCharacter(characterId);
  if (!c) return;
  c.energy.current = clamp(c.energy.current + delta, 0, c.energy.max);
}

function adjustNpcEnergy(npcId, delta) {
  const n = findNpc(npcId);
  if (!n) return;
  n.energy.current = clamp(n.energy.current + delta, 0, n.energy.max);
}

function adjustArmor(characterId, delta) {
  const c = findCharacter(characterId);
  if (!c) return;
  c.armor = Math.max(0, c.armor + delta);
}

// Статус "убит" — чисто визуальная метка (крестик поверх токена), как у NPC.
// Не персистится: HP/энергия/решимость персонажей и так не переживают
// перезапуск сервера (сбрасываются из characters.json), дохоп сюда не нужен.
function setCharacterDead(characterId, dead) {
  const c = findCharacter(characterId);
  if (!c) return;
  c.dead = !!dead;
}

function adjustNpcArmor(npcId, delta) {
  const n = findNpc(npcId);
  if (!n) return;
  n.armor = Math.max(0, n.armor + delta);
}

// Видимость и статус "убит" персистятся в npcs.json — тот же принцип, что и
// у аватара NPC (см. setNpcAvatar), чтобы решение мастера не сбрасывалось
// при перезапуске сервера.
function setNpcVisible(npcId, visible) {
  const n = findNpc(npcId);
  if (!n) return;
  n.visible = !!visible;
  try {
    fs.writeFileSync(NPCS_FILE, JSON.stringify(npcs, null, 2));
  } catch (err) {
    console.warn('Не удалось сохранить npcs.json:', err.message);
  }
}

function setNpcDead(npcId, dead) {
  const n = findNpc(npcId);
  if (!n) return;
  n.dead = !!dead;
  try {
    fs.writeFileSync(NPCS_FILE, JSON.stringify(npcs, null, 2));
  } catch (err) {
    console.warn('Не удалось сохранить npcs.json:', err.message);
  }
}

// Статус NPC (враг/союзник/нейтрал) — по умолчанию (поле отсутствует в
// npcs.json) считается "нейтрал", см. фолбэк в getPublicState/gm.js.
const NPC_FACTIONS = ['enemy', 'ally', 'neutral'];
function setNpcFaction(npcId, faction) {
  if (!NPC_FACTIONS.includes(faction)) return;
  const n = findNpc(npcId);
  if (!n) return;
  n.faction = faction;
  try {
    fs.writeFileSync(NPCS_FILE, JSON.stringify(npcs, null, 2));
  } catch (err) {
    console.warn('Не удалось сохранить npcs.json:', err.message);
  }
}

// Переносит NPC в другую локацию вручную (например, компаньон идёт с
// партией). Старая позиция теряет смысл в новой сетке — сбрасываем,
// ГМ разместит NPC заново на канвасе (как и при первом создании NPC).
function setNpcLocation(npcId, locationId) {
  const n = findNpc(npcId);
  if (!n || !findLocation(locationId)) return;
  n.locationId = locationId;
  n.position = undefined;
  try {
    fs.writeFileSync(NPCS_FILE, JSON.stringify(npcs, null, 2));
  } catch (err) {
    console.warn('Не удалось сохранить npcs.json:', err.message);
  }
}

// ---- Локации -------------------------------------------------------------
// ГМ создаёт локации прямо по ходу игры (не конфиг-файлом), может готовить
// несколько заранее, потом переключаться (см. setActiveLocation).
function addLocation(name, gridWidth, gridHeight) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const w = clamp(Number(gridWidth) || config.DEFAULT_LOCATION_WIDTH, config.MIN_LOCATION_SIZE, config.MAX_LOCATION_SIZE);
  const h = clamp(Number(gridHeight) || config.DEFAULT_LOCATION_HEIGHT, config.MIN_LOCATION_SIZE, config.MAX_LOCATION_SIZE);
  const id = slugifyId(trimmed, new Set(locations.map((l) => l.id)));
  const location = { id, name: trimmed.slice(0, config.LOCATION_NAME_MAX_LENGTH), gridWidth: w, gridHeight: h };
  locations.push(location);
  saveLocations();
  return location;
}

function renameLocation(locationId, name) {
  const l = findLocation(locationId);
  const trimmed = String(name || '').trim();
  if (!l || !trimmed) return;
  l.name = trimmed.slice(0, config.LOCATION_NAME_MAX_LENGTH);
  saveLocations();
}

// Переключает активную локацию: сохраняет позиции персонажей для прежней
// локации, восстанавливает (или спавнит заново) для новой.
function setActiveLocation(locationId) {
  const location = findLocation(locationId);
  if (!location) return false;
  if (location.id === state.activeLocationId) return true;
  characters.forEach((c) => {
    if (!c.locationPositions) c.locationPositions = {};
    if (c.position) c.locationPositions[state.activeLocationId] = c.position;
  });
  state.activeLocationId = location.id;
  let offset = 0;
  characters.forEach((c) => {
    const saved = c.locationPositions[location.id];
    c.position = saved || map.defaultSpawn(location, offset++);
  });
  return true;
}

// Удалить локацию можно только если она не активна, не последняя и в ней
// нет NPC (иначе — понятная причина отказа для ack на клиенте).
function removeLocation(locationId) {
  if (locations.length <= 1) return { ok: false, reason: 'last-location' };
  if (locationId === state.activeLocationId) return { ok: false, reason: 'active-location' };
  if (npcs.some((n) => n.locationId === locationId)) return { ok: false, reason: 'has-npcs' };
  const idx = locations.findIndex((l) => l.id === locationId);
  if (idx === -1) return { ok: false, reason: 'unknown-location' };
  locations.splice(idx, 1);
  saveLocations();
  state.mapImages = state.mapImages.filter((m) => m.locationId !== locationId);
  state.drawings = state.drawings.filter((d) => d.locationId !== locationId);
  delete state.fog[locationId];
  characters.forEach((c) => { if (c.locationPositions) delete c.locationPositions[locationId]; });
  return { ok: true };
}

function restorePartyResources() {
  characters.forEach((c) => {
    c.energy.current = c.energy.max;
    c.resolve.current = c.resolve.max;
  });
}

// Автовосстановление только энергии (не решимости) при завершении боя —
// решимость остаётся тратиться/копиться между боями в рамках сессии.
// Восстанавливаем и персонажам, и NPC — оба участвуют в бою и тратят
// энергию на перемещение одинаково (adjustEnergy/adjustNpcEnergy).
function restorePartyEnergy() {
  characters.forEach((c) => {
    c.energy.current = c.energy.max;
  });
  npcs.forEach((n) => {
    n.energy.current = n.energy.max;
  });
}

function setDc(dc) {
  const value = Number(dc);
  state.currentDc = Number.isFinite(value) && value > 0 ? value : null;
}

// Сохраняет назначение аватара персонажу и персистит его в avatars.json,
// чтобы выбор пережил перезапуск сервера.
function setCharacterAvatar(characterId, url) {
  const c = findCharacter(characterId);
  if (!c) return;
  c.avatar = url;
  avatarAssignments[characterId] = url;
  try {
    fs.writeFileSync(AVATARS_FILE, JSON.stringify(avatarAssignments, null, 2));
  } catch (err) {
    console.warn('Не удалось сохранить avatars.json:', err.message);
  }
}

// Декодирует data URL (data:image/...;base64,...), пишет файл на диск и
// назначает его персонажу. Без внешних зависимостей — только fs/Buffer.
function saveUploadedAvatar(characterId, dataUrl) {
  const c = findCharacter(characterId);
  if (!c || typeof dataUrl !== 'string') return null;
  const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > config.AVATAR_UPLOAD_MAX_SIZE) return null; // защита от гигантских картинок
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const fileName = `${characterId}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, fileName), buffer);
  const url = `/avatars/uploads/${fileName}`;
  setCharacterAvatar(characterId, url);
  return url;
}

// NPC не хранят аватар в отдельном файле (как персонажи в avatars.json) —
// у них нет пересоздания при каждом запуске сервера из "нулевого" шаблона
// join-потока, поэтому проще персистить прямо в npcs.json.
function setNpcAvatar(npcId, url) {
  const n = findNpc(npcId);
  if (!n) return;
  n.avatar = url;
  try {
    fs.writeFileSync(NPCS_FILE, JSON.stringify(npcs, null, 2));
  } catch (err) {
    console.warn('Не удалось сохранить npcs.json:', err.message);
  }
}

function saveUploadedNpcAvatar(npcId, dataUrl) {
  const n = findNpc(npcId);
  if (!n || typeof dataUrl !== 'string') return null;
  const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > config.AVATAR_UPLOAD_MAX_SIZE) return null; // защита от гигантских картинок
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const fileName = `${npcId}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, fileName), buffer);
  const url = `/avatars/uploads/${fileName}`;
  setNpcAvatar(npcId, url);
  return url;
}

function giveItem(characterId, item) {
  const c = findCharacter(characterId);
  if (!c || typeof item !== 'string') return;
  const trimmed = item.trim();
  if (!trimmed) return;
  if (!Array.isArray(c.inventory)) c.inventory = [];
  c.inventory.push(trimmed);
}

function removeItem(characterId, index) {
  const c = findCharacter(characterId);
  if (!c || !Array.isArray(c.inventory)) return;
  if (index < 0 || index >= c.inventory.length) return;
  c.inventory.splice(index, 1);
}

function giveNpcItem(npcId, item) {
  const n = findNpc(npcId);
  if (!n || typeof item !== 'string') return;
  const trimmed = item.trim();
  if (!trimmed) return;
  if (!Array.isArray(n.inventory)) n.inventory = [];
  n.inventory.push(trimmed);
}

function removeNpcItem(npcId, index) {
  const n = findNpc(npcId);
  if (!n || !Array.isArray(n.inventory)) return;
  if (index < 0 || index >= n.inventory.length) return;
  n.inventory.splice(index, 1);
}

// Генерирует уникальный id из имени (транслитерация не нужна — просто
// нормализуем в latin+digits, при коллизии добавляем счётчик).
function slugifyId(name, existingIds) {
  const base = String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'entity';
  let id = base;
  let n = 1;
  while (existingIds.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

// Добавляет нового персонажа во время сессии (пилот Vue-панели «Участники»).
// ВАЖНО: не персистится в characters.json — при перезапуске сервера
// добавленный персонаж исчезнет (известное ограничение пилота, см. план).
function addCharacter(data) {
  const name = String(data?.name || '').trim();
  if (!name) return null;
  const id = slugifyId(name, new Set(characters.map((c) => c.id)));
  const hpMax = Number(data?.hp) > 0 ? Number(data.hp) : 10;
  const energyMax = Number(data?.energy) > 0 ? Number(data.energy) : 6;
  const resolveMax = Number(data?.resolve) > 0 ? Number(data.resolve) : 3;
  const code = generateCode();
  characterCodes[id] = code;
  saveCharacterCodes();
  const character = {
    id,
    name,
    title: '',
    color: '#888888',
    attributes: {
      body: Number(data?.attributes?.body) || 0,
      mind: Number(data?.attributes?.mind) || 0,
      charisma: Number(data?.attributes?.charisma) || 0,
    },
    hp: { current: hpMax, max: hpMax },
    resolve: { current: resolveMax, max: resolveMax },
    energy: { current: energyMax, max: energyMax },
    skills: [],
    inventory: [],
    backstory: '',
    hook: '',
    claimedBy: null,
    socketId: null,
    avatar: null,
    code,
    armor: 0,
    dead: false,
    position: map.defaultSpawn(getActiveLocation(), spawnOffset),
    locationPositions: {},
  };
  spawnOffset += 1;
  characters.push(character);
  return character;
}

// Удаляет персонажа из текущей сессии безвозвратно (только из памяти —
// characters.json не трогаем, см. addCharacter).
function removeCharacter(characterId) {
  const idx = characters.findIndex((c) => c.id === characterId);
  if (idx === -1) return;
  characters.splice(idx, 1);
}

// Добавляет нового NPC — персистится в npcs.json сразу же (тот же принцип,
// что и setNpcVisible/setNpcDead), т.к. NPC переживают перезапуск сервера.
function addNpc(data) {
  const name = String(data?.name || '').trim();
  if (!name) return null;
  const id = slugifyId(name, new Set(npcs.map((n) => n.id)));
  const hpMax = Number(data?.hp) > 0 ? Number(data.hp) : 10;
  const energyMax = Number(data?.energy) > 0 ? Number(data.energy) : 6;
  const npc = {
    id,
    name,
    role: String(data?.role || '').trim() || 'NPC',
    attributes: {
      body: Number(data?.attributes?.body) || 0,
      mind: Number(data?.attributes?.mind) || 0,
      charisma: Number(data?.attributes?.charisma) || 0,
    },
    hp: { current: hpMax, max: hpMax },
    energy: { current: energyMax, max: energyMax },
    inventory: [],
    avatar: null,
    notes: '',
    secret: '',
    armor: 0,
    visible: false,
    dead: false,
    faction: 'neutral',
    locationId: state.activeLocationId,
  };
  npcs.push(npc);
  try {
    fs.writeFileSync(NPCS_FILE, JSON.stringify(npcs, null, 2));
  } catch (err) {
    console.warn('Не удалось сохранить npcs.json:', err.message);
  }
  return npc;
}

function removeNpc(npcId) {
  const idx = npcs.findIndex((n) => n.id === npcId);
  if (idx === -1) return;
  npcs.splice(idx, 1);
  try {
    fs.writeFileSync(NPCS_FILE, JSON.stringify(npcs, null, 2));
  } catch (err) {
    console.warn('Не удалось сохранить npcs.json:', err.message);
  }
}

// Редактирование данных персонажа из диалога «Инфо» (имя/title/hook/backstory/
// навыки/атрибуты). НЕ персистится в characters.json — тот же принцип, что и
// addCharacter/removeCharacter. HP/энергия/решимость/броня/инвентарь/код/dead
// сюда не входят — у них уже есть свои узкие хендлеры.
function updateCharacter(characterId, data) {
  const character = findCharacter(characterId);
  if (!character) return;
  if (typeof data?.name === 'string' && data.name.trim()) character.name = data.name.trim();
  if (typeof data?.title === 'string') character.title = data.title.trim();
  if (typeof data?.hook === 'string') character.hook = data.hook.trim();
  if (typeof data?.backstory === 'string') character.backstory = data.backstory.trim();
  if (Array.isArray(data?.skills)) {
    character.skills = data.skills.filter((s) => typeof s === 'string' && skillsCatalog[s]);
  }
  if (data?.attributes) {
    character.attributes = {
      body: Number(data.attributes.body) || 0,
      mind: Number(data.attributes.mind) || 0,
      charisma: Number(data.attributes.charisma) || 0,
    };
  }
}

// Редактирование данных NPC из диалога «Инфо» (имя/роль/заметки/секрет/
// атрибуты) — персистится в npcs.json, тот же принцип, что addNpc/setNpcVisible.
// HP/энергия/броня/инвентарь/видимость/dead/faction/аватар сюда не входят —
// у них уже есть свои узкие хендлеры.
function updateNpc(npcId, data) {
  const npc = findNpc(npcId);
  if (!npc) return;
  if (typeof data?.name === 'string' && data.name.trim()) npc.name = data.name.trim();
  if (typeof data?.role === 'string') npc.role = data.role.trim() || 'NPC';
  if (typeof data?.notes === 'string') npc.notes = data.notes.trim();
  if (typeof data?.secret === 'string') npc.secret = data.secret.trim();
  if (data?.attributes) {
    npc.attributes = {
      body: Number(data.attributes.body) || 0,
      mind: Number(data.attributes.mind) || 0,
      charisma: Number(data.attributes.charisma) || 0,
    };
  }
  try {
    fs.writeFileSync(NPCS_FILE, JSON.stringify(npcs, null, 2));
  } catch (err) {
    console.warn('Не удалось сохранить npcs.json:', err.message);
  }
}

// Двигает персонажа на (x, y). Вне боя перемещение свободное (только
// проверка проходимости, без энергии) — энергобюджет и BFS-достижимость
// действуют только во время боя, и только в свой ход по инициативе.
function moveCharacter(characterId, target) {
  const c = findCharacter(characterId);
  if (!c) return { ok: false, reason: 'unknown-character' };

  if (!state.combat.active) {
    if (!map.isWalkable(getActiveLocation(), target.x, target.y)) {
      return { ok: false, reason: 'not-walkable' };
    }
    c.position = { x: target.x, y: target.y };
    return { ok: true, cost: 0 };
  }

  const turn = state.combat.order[state.combat.currentIndex];
  if (!turn || turn.type !== 'character' || turn.id !== characterId) {
    return { ok: false, reason: 'not-your-turn' };
  }

  const result = map.isReachable(getActiveLocation(), c.position, target, c.energy.current);
  if (!result.ok) return result;

  c.position = { x: target.x, y: target.y };
  c.energy.current = clamp(c.energy.current - result.cost, 0, c.energy.max);
  return { ok: true, cost: result.cost };
}

// Свободное перемещение для мастера — без учёта энергии, но всё равно
// нельзя поставить персонажа в незаблокированную/несуществующую клетку.
function forceMoveCharacter(characterId, target) {
  const c = findCharacter(characterId);
  if (!c) return { ok: false, reason: 'unknown-character' };
  if (!map.isWalkable(getActiveLocation(), target.x, target.y)) {
    return { ok: false, reason: 'not-walkable' };
  }
  c.position = { x: target.x, y: target.y };
  return { ok: true };
}

// Свободное перемещение NPC мастером — тот же принцип, что и у forceMoveCharacter:
// без энергобюджета, только проверка проходимости клетки.
function forceMoveNpc(npcId, target) {
  const n = findNpc(npcId);
  if (!n) return { ok: false, reason: 'unknown-npc' };
  if (n.locationId !== state.activeLocationId) return { ok: false, reason: 'wrong-location' };
  if (!map.isWalkable(getActiveLocation(), target.x, target.y)) {
    return { ok: false, reason: 'not-walkable' };
  }
  n.position = { x: target.x, y: target.y };
  return { ok: true };
}

// Подсветка достижимых клеток нужна только в бою (вне боя перемещение
// свободное — см. moveCharacter, клиент не гейтит тап по reachable).
function getReachableCells(characterId) {
  if (!state.combat.active) return [];
  const c = findCharacter(characterId);
  if (!c) return [];
  const turn = state.combat.order[state.combat.currentIndex];
  if (!turn || turn.type !== 'character' || turn.id !== characterId) return [];
  const reachable = map.findReachable(getActiveLocation(), c.position, c.energy.current);
  return Array.from(reachable.entries()).map(([key, cost]) => {
    const [x, y] = key.split(',').map(Number);
    return { x, y, cost };
  });
}

// DC берётся из текущего значения, заданного мастером (не с клиента).
// spendResolve: если true и есть Решимость — списать 1 и добавить +2 к сумме.
// label: имя для лога, когда бросок не привязан к персонажу (свободный бросок мастера).
function rollDice(characterId, attribute, spendResolve, label) {
  const c = findCharacter(characterId);
  // NPC не имеют Решимости, но имеют те же атрибуты — id персонажей и NPC
  // не пересекаются, поэтому безопасно проверить оба справочника по одному id.
  const n = !c ? findNpc(characterId) : null;
  const entity = c || n;
  const attrValue = entity && entity.attributes && entity.attributes[attribute] !== undefined ? entity.attributes[attribute] : 0;
  const die = Math.floor(Math.random() * 20) + 1;

  let resolveBonus = 0;
  if (spendResolve && c && c.resolve.current > 0) {
    c.resolve.current = clamp(c.resolve.current - 1, 0, c.resolve.max);
    resolveBonus = 2;
  }

  const dc = state.currentDc;
  const total = die + attrValue + resolveBonus;
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    characterId,
    characterName: entity ? entity.name : (label || 'Мастер'),
    attribute,
    die,
    attrValue,
    resolveBonus,
    total,
    dc: dc || null,
    success: dc ? total >= dc : null,
    critical: die === 20 ? 'success' : die === 1 ? 'fail' : null,
    time: new Date().toISOString(),
  };
  state.diceLog.unshift(entry);
  state.diceLog = state.diceLog.slice(0, 30);
  return entry;
}

// Разбирает выражение кубика для команды чата /roll — независимо от
// rollDice() (тот — d20+атрибут+DC для персонажей). Поддерживает:
// "10" (= 1d10, как в примере "/roll 10"), "2d6", "2d6+3", "2d6-1".
function parseDiceExpression(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  let count = 1;
  let sides;
  let mod = 0;
  const withD = s.match(/^(\d{1,2})?d(\d{1,4})([+-]\d{1,3})?$/);
  if (withD) {
    if (withD[1]) count = Number(withD[1]);
    sides = Number(withD[2]);
    if (withD[3]) mod = Number(withD[3]);
  } else if (/^\d{1,4}$/.test(s)) {
    sides = Number(s);
  } else {
    return null;
  }
  if (!Number.isInteger(count) || count < 1 || count > config.DICE_ROLL_MAX_COUNT) return null;
  if (!Number.isInteger(sides) || sides < 2 || sides > config.DICE_ROLL_MAX_SIDES) return null;
  return { count, sides, mod };
}

// Бросает count кубиков по sides граней + mod, форматирует готовую строку
// для системного чат-сообщения (тот же паттерн, что и "запускает звук"
// в index.js) — используется командой чата /roll.
function formatFreeRoll(count, sides, mod) {
  const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
  const sum = rolls.reduce((a, b) => a + b, 0);
  const total = sum + mod;
  const expr = `${count}d${sides}${mod ? (mod > 0 ? `+${mod}` : mod) : ''}`;
  const rollsStr = rolls.map((r) => `🎲${r}`).join(' + ');
  const modStr = mod ? ` ${mod > 0 ? '+' : '-'} ${Math.abs(mod)}` : '';
  const eq = (count > 1 || mod) ? ` = ${total}` : '';
  return `бросает ${expr}: ${rollsStr}${modStr}${eq}`;
}

// Туман войны: сервер — тупой ретранслятор. Хранит непрозрачный blob-строку
// (сетка тумана кодируется на клиенте) отдельно для каждой локации и
// персистит весь объект в fog.json.
function setFog(blob) {
  if (typeof blob !== 'string' || blob.length > config.FOG_MAX_SIZE) return;
  state.fog[state.activeLocationId] = blob;
  try {
    fs.writeFileSync(FOG_FILE, JSON.stringify(state.fog));
  } catch (err) {
    console.warn('Не удалось сохранить fog.json:', err.message);
  }
}

function getFog() {
  return state.fog[state.activeLocationId] || '';
}

// ---- Музыка -------------------------------------------------------------
// Мастер выбирает трек по id из манифеста (клиент знает файлы, сервер —
// только непрозрачный id, как и с саундбордом). Позиция синхронизируется
// виртуально: startedAt — момент, от которого отсчитывается currentTime
// (Date.now()-startedAt)/1000, сдвинутый на pausedAt при возобновлении, —
// клиенты сами крутят audio.currentTime под это, сервер только хранит числа.
function setMusicTrack(trackId) {
  if (typeof trackId !== 'string' || !trackId) return state.music;
  state.music = { trackId, playing: true, startedAt: Date.now(), pausedAt: 0 };
  return state.music;
}

function playMusic() {
  if (!state.music.trackId || state.music.playing) return state.music;
  state.music.playing = true;
  state.music.startedAt = Date.now() - state.music.pausedAt * 1000;
  return state.music;
}

function pauseMusic() {
  if (!state.music.trackId || !state.music.playing) return state.music;
  state.music.pausedAt = (Date.now() - state.music.startedAt) / 1000;
  state.music.playing = false;
  return state.music;
}

function stopMusic() {
  state.music = { trackId: null, playing: false, startedAt: null, pausedAt: 0 };
  return state.music;
}

// ---- Саундборд/музыка: загрузка файлов -----------------------------------
// ГМ может пополнять/чистить те же манифесты, из которых клиент (soundboard.js/
// music.js) читает список звуков/треков (см. public/assets/sounds|music/manifest.json).
// Декодирование dataURL — тот же принцип, что у addMapImage, но для audio/*.
const SOUNDS_DIR = path.join(__dirname, '..', 'public', 'assets', 'sounds');
const SOUNDS_MANIFEST_FILE = path.join(SOUNDS_DIR, 'manifest.json');
const MUSIC_DIR = path.join(__dirname, '..', 'public', 'assets', 'music');
const MUSIC_MANIFEST_FILE = path.join(MUSIC_DIR, 'manifest.json');

const AUDIO_EXT_BY_MIME = { mpeg: 'mp3', wav: 'wav', 'x-wav': 'wav', ogg: 'ogg' };

function readManifest(file) {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

function writeManifest(file, list) {
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
}

function addAudioEntry(dir, manifestFile, maxSize, name, dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:audio\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  const ext = AUDIO_EXT_BY_MIME[match[1]];
  if (!ext) return null; // неподдерживаемый формат — принимаем только mp3/wav/ogg
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > maxSize) return null; // защита от гигантских файлов
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fileName = `${id}.${ext}`;
  fs.writeFileSync(path.join(dir, fileName), buffer);
  const label = (typeof name === 'string' && name.trim() ? name.trim() : id).slice(0, config.AUDIO_LABEL_MAX_LENGTH);
  const entry = { id, label, file: fileName };
  const list = readManifest(manifestFile);
  list.push(entry);
  writeManifest(manifestFile, list);
  return entry;
}

function removeAudioEntry(dir, manifestFile, id) {
  const list = readManifest(manifestFile);
  const idx = list.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  const [removed] = list.splice(idx, 1);
  writeManifest(manifestFile, list);
  if (removed && removed.file) {
    const filePath = path.join(dir, path.basename(removed.file));
    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') console.warn('Не удалось удалить аудиофайл:', err.message);
    });
  }
  return true;
}

function addSound(name, dataUrl) {
  return addAudioEntry(SOUNDS_DIR, SOUNDS_MANIFEST_FILE, config.SOUND_UPLOAD_MAX_SIZE, name, dataUrl);
}

function removeSound(id) {
  return removeAudioEntry(SOUNDS_DIR, SOUNDS_MANIFEST_FILE, id);
}

function addMusicTrack(name, dataUrl) {
  return addAudioEntry(MUSIC_DIR, MUSIC_MANIFEST_FILE, config.MUSIC_UPLOAD_MAX_SIZE, name, dataUrl);
}

function removeMusicTrack(id) {
  const removed = removeAudioEntry(MUSIC_DIR, MUSIC_MANIFEST_FILE, id);
  if (removed && state.music.trackId === id) {
    stopMusic();
    return { removed: true, wasPlaying: true };
  }
  return { removed, wasPlaying: false };
}

// ---- Картинки на карте --------------------------------------------------
// Мастер накладывает произвольные картинки (хендауты/доп. арт/собственный
// фон карты — движок своего дефолтного фона не задаёт). Декодирование data
// URL — тот же принцип, что и у аватаров (см. saveUploadedAvatar), но без
// каталога UPLOADS_DIR персонажей — файлы кладём в отдельную папку map-images.
const MAP_IMAGES_DIR = path.join(__dirname, '..', 'public', 'avatars', 'map-images');

function findMapImage(id) {
  return state.mapImages.find((m) => m.id === id);
}

// naturalWidth/naturalHeight — реальный размер файла (клиент вычисляет
// перед отправкой); позиция по умолчанию — центр карты. name — исходное
// имя загруженного файла (для отображения в списке картинок на панели ГМ).
// x/y — опциональная позиция размещения (например, центр текущего вьюпорта
// ГМ на момент загрузки, см. mapController.getCameraCenter() в
// MapToolsPanel.vue); при отсутствии/невалидности — фолбэк на центр карты,
// как раньше.
function addMapImage(dataUrl, naturalWidth, naturalHeight, name, x, y) {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  const w = Number(naturalWidth);
  const h = Number(naturalHeight);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > config.MAP_IMAGE_UPLOAD_MAX_SIZE) return null; // защита от гигантских картинок
  if (!fs.existsSync(MAP_IMAGES_DIR)) fs.mkdirSync(MAP_IMAGES_DIR, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fileName = `${id}.${ext}`;
  fs.writeFileSync(path.join(MAP_IMAGES_DIR, fileName), buffer);
  const location = getActiveLocation();
  const posX = Number(x);
  const posY = Number(y);
  const entry = {
    id,
    url: `/avatars/map-images/${fileName}`,
    name: typeof name === 'string' ? name.trim().slice(0, config.MAP_IMAGE_NAME_MAX_LENGTH) : '',
    x: Number.isFinite(posX) ? posX : (location.gridWidth * config.CELL_SIZE) / 2,
    y: Number.isFinite(posY) ? posY : (location.gridHeight * config.CELL_SIZE) / 2 + 20,
    naturalWidth: w,
    naturalHeight: h,
    scale: 1,
    rotation: 0,
    locked: false,
    locationId: state.activeLocationId,
  };
  state.mapImages.push(entry);
  return entry;
}

// Частичное обновление позиции/масштаба/блокировки — только мастер (гейт в index.js).
function updateMapImage(id, patch) {
  const m = findMapImage(id);
  if (!m) return null;
  if (typeof patch.x === 'number') m.x = patch.x;
  if (typeof patch.y === 'number') m.y = patch.y;
  if (typeof patch.scale === 'number' && patch.scale > 0) m.scale = clamp(patch.scale, 0.05, 10);
  if (typeof patch.rotation === 'number' && Number.isFinite(patch.rotation)) m.rotation = patch.rotation;
  if (typeof patch.locked === 'boolean') m.locked = patch.locked;
  return m;
}

function removeMapImage(id) {
  const idx = state.mapImages.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  const [removed] = state.mapImages.splice(idx, 1);
  if (removed && removed.url) {
    const filePath = path.join(MAP_IMAGES_DIR, path.basename(removed.url));
    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') console.warn('Не удалось удалить файл картинки карты:', err.message);
    });
  }
  return true;
}

// ---- Рисование на карте --------------------------------------------------
// Свободные штрихи (перо/ластик) от ГМ и игроков — общий слой поверх карты.
// points — мировые px (как x/y у mapImages), не привязаны к клеткам сетки.
// Каждый штрих привязан к автору (authorId — characterId игрока или 'gm'),
// поэтому ластик и отмена действуют только на штрихи того же автора
// (см. removeDrawing/undoLastDrawing и гейты в index.js). Цвет определяет
// сервер по authorId — берётся из characters.json (поле color), клиент
// цвет не присылает и не может его подменить.
const DEFAULT_DRAW_COLOR = '#cccccc';
const drawColorByCharacterId = Object.fromEntries(
  characters.map((c) => [c.id, c.color || DEFAULT_DRAW_COLOR])
);
const GM_DRAW_COLOR = '#ffffff';

function addDrawing(authorId, authorRole, points, width) {
  if (typeof authorId !== 'string' || !authorId) return null;
  if (!Array.isArray(points) || !points.length || points.length > config.MAX_STROKE_POINTS) return null;
  const cleanPoints = [];
  for (const p of points) {
    const x = Number(p && p.x);
    const y = Number(p && p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    cleanPoints.push({ x, y });
  }
  const w = Number(width);
  const safeWidth = Number.isFinite(w) ? clamp(w, 1, 40) : 4;
  const color = authorRole === 'gm' ? GM_DRAW_COLOR : (drawColorByCharacterId[authorId] || DEFAULT_DRAW_COLOR);
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    authorId,
    authorRole: authorRole === 'gm' ? 'gm' : 'player',
    color,
    width: safeWidth,
    points: cleanPoints,
    locationId: state.activeLocationId,
  };
  state.drawings.push(entry);
  if (state.drawings.length > config.MAX_DRAWINGS) state.drawings.splice(0, state.drawings.length - config.MAX_DRAWINGS);
  return entry;
}

// Стирает один штрих, но только если он принадлежит requesterId — игроки
// (и ГМ) не могут стереть чужие рисунки поштрихово. Полный сброс для ГМ —
// отдельная функция clearDrawings().
function removeDrawing(id, requesterId) {
  const idx = state.drawings.findIndex(
    (d) => d.id === id && d.authorId === requesterId && d.locationId === state.activeLocationId
  );
  if (idx === -1) return false;
  state.drawings.splice(idx, 1);
  return true;
}

// Отменяет ПОСЛЕДНИЙ штрих ИМЕННО этого автора в активной локации (не
// последний глобально) — свой собственный небольшой undo-стек внутри
// общего массива.
function undoLastDrawing(authorId) {
  for (let i = state.drawings.length - 1; i >= 0; i--) {
    if (state.drawings[i].authorId === authorId && state.drawings[i].locationId === state.activeLocationId) {
      state.drawings.splice(i, 1);
      return true;
    }
  }
  return false;
}

// Полный сброс рисунков ТОЛЬКО активной локации — только мастер (гейт в
// index.js), аналог "Скрыть всё"/"Открыть всё" у тумана войны.
function clearDrawings() {
  state.drawings = state.drawings.filter((d) => d.locationId !== state.activeLocationId);
  return true;
}

// ---- Боевой режим -------------------------------------------------------
// participants: [{ type: 'character'|'npc', id }] — мастер сам выбирает
// состав боя. Инициатива — d20+Тело, порядок хода строится по убыванию.
function startCombat(participants) {
  if (!Array.isArray(participants)) return state.combat;
  const order = participants
    .map((p) => {
      const entity = p.type === 'npc' ? findNpc(p.id) : findCharacter(p.id);
      if (!entity) return null;
      const body = (entity.attributes && entity.attributes.body) || 0;
      const die = Math.floor(Math.random() * 20) + 1;
      return { type: p.type, id: p.id, name: entity.name, die, initiative: die + body };
    })
    .filter(Boolean);
  order.sort((a, b) => b.initiative - a.initiative);
  state.combat = { active: true, round: 1, order, currentIndex: 0 };
  return state.combat;
}

function endCombat() {
  state.combat = { active: false, round: 0, order: [], currentIndex: 0 };
  return state.combat;
}

function nextTurn() {
  if (!state.combat.active || !state.combat.order.length) return state.combat;
  state.combat.currentIndex += 1;
  if (state.combat.currentIndex >= state.combat.order.length) {
    state.combat.currentIndex = 0;
    state.combat.round += 1;
  }
  return state.combat;
}

// Применяет урон к цели: броня поглощает часть урона (не ниже 0), остаток
// списывается с HP через уже существующие adjust*Hp-функции.
function applyDamage(targetType, targetId, rawAmount) {
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const target = targetType === 'npc' ? findNpc(targetId) : findCharacter(targetId);
  if (!target) return null;
  const finalDamage = Math.max(0, Math.round(amount) - target.armor);
  if (targetType === 'npc') adjustNpcHp(targetId, -finalDamage);
  else adjustCharacterHp(targetId, -finalDamage);
  return { finalDamage, targetName: target.name };
}

// Общий чат: свободные сообщения + системные уведомления (например, о звуках).
// Персистится в chat.json по тому же принципу, что и fog.json.
function addChatMessage(author, text, kind = 'user') {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().slice(0, config.CHAT_MESSAGE_MAX_LENGTH);
  if (!trimmed) return null;
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    author: author || 'Аноним',
    text: trimmed,
    kind, // 'user' | 'system'
    time: new Date().toISOString(),
  };
  state.chat.push(entry);
  state.chat = state.chat.slice(-config.CHAT_HISTORY_LIMIT);
  try {
    fs.writeFileSync(CHAT_FILE, JSON.stringify(state.chat));
  } catch (err) {
    console.warn('Не удалось сохранить chat.json:', err.message);
  }
  return entry;
}

// Снимок runtime-состояния (ресурсы/позиции персонажей и NPC, бой, DC,
// лог бросков) — персистится в runtime.json, чтобы пережить
// перезапуск сервера. Вызывается из broadcastState() после каждой мутации.
function persistRuntimeState() {
  const snapshot = {
    currentDc: state.currentDc,
    diceLog: state.diceLog,
    combat: state.combat,
    mapImages: state.mapImages,
    drawings: state.drawings,
    music: state.music,
    activeLocationId: state.activeLocationId,
    characters: {},
    npcs: {},
  };
  characters.forEach((c) => {
    snapshot.characters[c.id] = {
      hp: c.hp.current,
      energy: c.energy.current,
      resolve: c.resolve.current,
      armor: c.armor,
      dead: c.dead,
      position: c.position,
      locationPositions: c.locationPositions || {},
    };
  });
  npcs.forEach((n) => {
    snapshot.npcs[n.id] = {
      hp: n.hp.current,
      energy: n.energy.current,
      armor: n.armor,
      position: n.position,
    };
  });
  try {
    fs.writeFileSync(RUNTIME_FILE, JSON.stringify(snapshot));
  } catch (err) {
    console.warn('Не удалось сохранить runtime.json:', err.message);
  }
}

function getPublicState() {
  const activeId = state.activeLocationId;
  return {
    currentDc: state.currentDc,
    // Код доступа — секрет между ГМ и игроком, игрокам (в т.ч. чужим) видны
    // только остальные поля персонажа.
    characters: characters.map(({ code, ...rest }) => rest),
    diceLog: state.diceLog,
    map: getActiveLocationLayout(),
    activeLocationId: activeId,
    skillsCatalog,
    chat: state.chat,
    combat: state.combat,
    // Картинки/рисунки — только активной локации (то же множество, что уже
    // рисуется на канвасе).
    mapImages: state.mapImages.filter((m) => m.locationId === activeId),
    drawings: state.drawings.filter((d) => d.locationId === activeId),
    // Музыка — общее состояние воспроизведения, видно всем (у каждого клиента
    // своя громкость, но трек и позиция синхронны).
    music: state.music,
    // Игрокам видны только NPC активной локации, которых мастер явно сделал видимыми.
    npcs: npcs.filter((n) => n.visible && n.position && n.locationId === activeId),
  };
}

function getGMState() {
  return {
    ...getPublicState(),
    characters,
    // ВСЕ NPC всех локаций (нефильтрованные) — панель «Персонажи» нужна ГМ
    // для подготовки локаций заранее, до переключения на них.
    npcs,
    // Полный список локаций — для панели переключения/управления.
    locations,
  };
}

module.exports = {
  claimCharacter,
  verifyCharacterCode,
  regenerateCharacterCode,
  releaseSocket,
  adjustCharacterHp,
  adjustResolve,
  adjustEnergy,
  adjustNpcHp,
  adjustNpcEnergy,
  adjustArmor,
  adjustNpcArmor,
  setCharacterDead,
  setNpcVisible,
  setNpcDead,
  setNpcFaction,
  setNpcLocation,
  addLocation,
  renameLocation,
  setActiveLocation,
  removeLocation,
  restorePartyResources,
  restorePartyEnergy,
  setDc,
  setCharacterAvatar,
  saveUploadedAvatar,
  setNpcAvatar,
  saveUploadedNpcAvatar,
  giveItem,
  removeItem,
  giveNpcItem,
  removeNpcItem,
  addCharacter,
  removeCharacter,
  updateCharacter,
  addNpc,
  removeNpc,
  updateNpc,
  moveCharacter,
  forceMoveCharacter,
  forceMoveNpc,
  getReachableCells,
  rollDice,
  parseDiceExpression,
  formatFreeRoll,
  setFog,
  getFog,
  setMusicTrack,
  playMusic,
  pauseMusic,
  stopMusic,
  addSound,
  removeSound,
  addMusicTrack,
  removeMusicTrack,
  addMapImage,
  updateMapImage,
  removeMapImage,
  addDrawing,
  removeDrawing,
  undoLastDrawing,
  clearDrawings,
  addChatMessage,
  startCombat,
  endCombat,
  nextTurn,
  applyDamage,
  persistRuntimeState,
  getPublicState,
  getGMState,
};
