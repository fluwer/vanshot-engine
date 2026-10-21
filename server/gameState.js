const fs = require('fs');
const path = require('path');
const map = require('./map');
const config = require('./config');
const gameConfig = require('./gameConfig');
const videos = require('./videos');
const { writeFileAtomic } = require('./fsutil');

const DATA_DIR = path.join(__dirname, 'data');
const AVATARS_FILE = path.join(DATA_DIR, 'avatars.json');
const CODES_FILE = path.join(DATA_DIR, 'characterCodes.json');
const NPCS_FILE = path.join(DATA_DIR, 'npcs.json');
const FOG_FILE = path.join(DATA_DIR, 'fog.json');
const LOCATIONS_FILE = path.join(DATA_DIR, 'locations.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Всё, что программа сама записывает или что ГМ «подкладывает» (загруженные аватары и картинки карты,
// загруженные музыка и звуки, свои готовые картинки героев), лежит в data/: это единственный каталог,
// который в Docker вынесен на диск хоста (volume), а public/ и server/ запечены в образ и при каждой
// пересборке создаются заново — всё, что лежало бы в public/, пропадало бы. index.js отдаёт эти папки
// через express.static под прежними адресами (/avatars/uploads/…, /avatars/map-images/…,
// /avatars/presets/…, /assets/music|sounds/…), поэтому клиент и сохранённые ссылки не меняются.
const UPLOADS_ROOT = path.join(DATA_DIR, 'uploads');
const UPLOADS_DIR = path.join(UPLOADS_ROOT, 'avatars');            // /avatars/uploads/…
const MAP_IMAGES_DIR = path.join(UPLOADS_ROOT, 'map-images');      // /avatars/map-images/…
const USER_PRESETS_DIR = path.join(DATA_DIR, 'presets');           // /avatars/presets/… — сюда кладёт файлы ГМ
const AUDIO_LIBRARY_FILE = path.join(DATA_DIR, 'audio-library.json'); // музыка/звуки, добавленные и скрытые ГМ
const AUDIO_UPLOAD_DIRS = {
  music: path.join(UPLOADS_ROOT, 'music'),                         // /assets/music/…
  sounds: path.join(UPLOADS_ROOT, 'sounds'),                       // /assets/sounds/…
};
const SFX_DIR = path.join(UPLOADS_ROOT, 'sfx');                    // /assets/sfx/… — свои звуки интерфейса (game.json → sfx)
const SKILLS_FILE = path.join(DATA_DIR, 'skills.json');            // каталог навыков (правит ГМ: экран «Игра»)

// Раньше загруженные аватары и картинки карты писались прямо в public/avatars/{uploads,map-images}.
// Если там что-то осталось (локальная разработка, контейнер, в который файлы вернули через docker cp),
// переносим в data/ при старте: адреса остаются прежними, но файлы больше не зависят от образа.
function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    fs.copyFileSync(from, to); // другой диск (volume): rename невозможен
    fs.unlinkSync(from);
  }
}
(function migrateLegacyUploads() {
  [
    [path.join(PUBLIC_DIR, 'avatars', 'uploads'), UPLOADS_DIR],
    [path.join(PUBLIC_DIR, 'avatars', 'map-images'), MAP_IMAGES_DIR],
  ].forEach(([from, to]) => {
    let names = [];
    try {
      names = fs.readdirSync(from, { withFileTypes: true }).filter((d) => d.isFile() && !d.name.startsWith('.')).map((d) => d.name);
    } catch (err) {
      return; // старой папки нет — переносить нечего
    }
    if (!names.length) return;
    fs.mkdirSync(to, { recursive: true });
    let moved = 0;
    names.forEach((name) => {
      const target = path.join(to, name);
      if (fs.existsSync(target)) return;
      try {
        moveFile(path.join(from, name), target);
        moved += 1;
      } catch (err) {
        console.warn(`Не удалось перенести ${name}:`, err.message);
      }
    });
    if (moved) console.log(`Перенесено файлов: ${moved} (${from} → ${to})`);
  });
}());

// «Пример игры» (герои, NPC, навыки, локации, аватары) лежит в server/defaults/ — он запечён в образ.
// Рабочие копии живут в data/ (том Docker) и правятся из интерфейса ГМ. Нет файла в data/ (чистый том,
// первый запуск, файл удалён) — берём его из примера, а не падаем при старте.
const DEFAULTS_DIR = path.join(__dirname, 'defaults');
(function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  ['characters.json', 'npcs.json', 'skills.json', 'avatars.json', 'locations.json'].forEach((name) => {
    const target = path.join(DATA_DIR, name);
    const source = path.join(DEFAULTS_DIR, name);
    if (fs.existsSync(target) || !fs.existsSync(source)) return;
    fs.copyFileSync(source, target);
    console.log(`data/${name} создан из примера (server/defaults/${name})`);
  });
}());

const characters = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'characters.json'), 'utf-8'));
const npcs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'npcs.json'), 'utf-8'));
const skillsCatalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'skills.json'), 'utf-8'));
const avatarAssignments = JSON.parse(fs.readFileSync(AVATARS_FILE, 'utf-8'));

// ---- Состав героев: правки ГМ поверх characters.json --------------------------
// characters.json — авторский шаблон, его в игре не переписываем. Всё, что ГМ меняет у героев
// по ходу игры (диалог «Инфо»: имя, титул, завязка, предыстория, заметки, навыки, атрибуты;
// выдача/изъятие предметов; добавление и удаление героев), пишется в roster.json и накладывается
// при старте: { edits: { id: { изменённые поля } }, added: [определения новых], removed: [id] }.
// В edits — только поля, отличающиеся от characters.json: авторские правки шаблона для героев,
// которых ГМ не трогал, продолжают подхватываться. Файл — игровые данные с заметками ГМ (в .gitignore).
const ROSTER_FILE = path.join(DATA_DIR, 'roster.json');
const ROSTER_FIELDS = ['name', 'title', 'hook', 'backstory', 'notes', 'skills', 'attributes', 'inventory'];
const cloneJson = (v) => JSON.parse(JSON.stringify(v));
const hasSkill = (name) => Object.prototype.hasOwnProperty.call(skillsCatalog, name);
const filterSkills = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string' && hasSkill(s)) : []);

// Шаблон — каким герои пришли из characters.json (навыки уже по каталогу): с ним сравниваем при сохранении.
const baseCharacters = cloneJson(characters).map((c) => ({ ...c, skills: filterSkills(c.skills), notes: typeof c.notes === 'string' ? c.notes : '' }));

function loadRoster() {
  for (const file of [ROSTER_FILE, `${ROSTER_FILE}.bak`]) {
    if (!fs.existsSync(file)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (raw && typeof raw === 'object') {
        return {
          edits: raw.edits && typeof raw.edits === 'object' ? raw.edits : {},
          added: Array.isArray(raw.added) ? raw.added : [],
          removed: Array.isArray(raw.removed) ? raw.removed : [],
        };
      }
    } catch (err) {
      console.error(`Не удалось прочитать ${path.basename(file)}:`, err.message);
    }
  }
  return { edits: {}, added: [], removed: [] };
}

// Новый герой из определения (roster.json → added): недостающее — умолчания, как у addCharacter.
function characterFromDefinition(def) {
  const max = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback);
  const hpMax = max(def.hp && def.hp.max, 10);
  const resolveMax = max(def.resolve && def.resolve.max, 3);
  const energyMax = max(def.energy && def.energy.max, 6);
  const a = def.attributes || {};
  return {
    id: def.id,
    name: String(def.name || def.id),
    title: typeof def.title === 'string' ? def.title : '',
    color: typeof def.color === 'string' ? def.color : '#888888',
    attributes: { body: Number(a.body) || 0, mind: Number(a.mind) || 0, charisma: Number(a.charisma) || 0 },
    hp: { current: hpMax, max: hpMax },
    resolve: { current: resolveMax, max: resolveMax },
    energy: { current: energyMax, max: energyMax },
    skills: Array.isArray(def.skills) ? def.skills : [],
    inventory: Array.isArray(def.inventory) ? def.inventory.filter((s) => typeof s === 'string') : [],
    backstory: typeof def.backstory === 'string' ? def.backstory : '',
    hook: typeof def.hook === 'string' ? def.hook : '',
    notes: typeof def.notes === 'string' ? def.notes : '',
  };
}

(function applyRoster() {
  const roster = loadRoster();
  for (let i = characters.length - 1; i >= 0; i--) {
    if (roster.removed.includes(characters[i].id)) characters.splice(i, 1);
  }
  characters.forEach((c) => {
    const edit = roster.edits[c.id];
    if (!edit || typeof edit !== 'object') return;
    ROSTER_FIELDS.forEach((f) => { if (f in edit) c[f] = cloneJson(edit[f]); });
  });
  roster.added.forEach((def) => {
    if (def && typeof def.id === 'string' && !characters.some((c) => c.id === def.id)) characters.push(characterFromDefinition(def));
  });
  characters.forEach((c) => { c.skills = filterSkills(c.skills); }); // навыки, убранные из каталога, отпадают
}());

// Определение героя для roster.json (текущие HP/энергия/решимость — в runtime.json, тут только максимумы).
function characterDefinition(c) {
  return {
    id: c.id,
    name: c.name,
    title: c.title,
    color: c.color,
    attributes: cloneJson(c.attributes),
    hp: { current: c.hp.max, max: c.hp.max },
    resolve: { current: c.resolve.max, max: c.resolve.max },
    energy: { current: c.energy.max, max: c.energy.max },
    skills: c.skills || [],
    inventory: c.inventory || [],
    backstory: c.backstory || '',
    hook: c.hook || '',
    notes: c.notes || '',
  };
}

function saveRoster() {
  try {
    const baseById = new Map(baseCharacters.map((b) => [b.id, b]));
    const edits = {};
    const added = [];
    characters.forEach((c) => {
      const base = baseById.get(c.id);
      if (!base) { added.push(characterDefinition(c)); return; }
      const diff = {};
      ROSTER_FIELDS.forEach((f) => {
        const cur = f === 'notes' ? (c.notes || '') : c[f];
        if (cur === undefined) return;
        if (JSON.stringify(cur) !== JSON.stringify(base[f])) diff[f] = cloneJson(cur);
      });
      if (Object.keys(diff).length) edits[c.id] = diff;
    });
    const removed = baseCharacters.filter((b) => !characters.some((c) => c.id === b.id)).map((b) => b.id);
    writeFileAtomic(ROSTER_FILE, JSON.stringify({ edits, added, removed }, null, 2));
  } catch (err) {
    console.warn('Не удалось сохранить roster.json:', err.message);
  }
}

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

// Локации — ГМ создаёт их прямо по ходу игры (не конфиг-файлом). Нет locations.json (в норме его
// создаёт ensureDataFiles из примера) или он пуст/битый — заводим одну пустую локацию.
let locations;
try {
  locations = JSON.parse(fs.readFileSync(LOCATIONS_FILE, 'utf-8'));
  if (!Array.isArray(locations) || !locations.length) throw new Error('empty locations.json');
} catch (err) {
  locations = [{
    id: 'start',
    name: 'Старт',
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
  // Погода на экране: одна на всю игру (не по локациям), задаёт ГМ — setWeather.
  // Рисует клиент (public/js/weather.js), сервер только хранит и раздаёт.
  weather: normalizeWeather(initialRuntime && initialRuntime.weather),
  // Показ ролика: { playId, id, startedAt } | null. Это событие, а не состояние партии — в runtime.json не пишется
  // (после перезапуска сервера показ не продолжается).
  video: null,
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
  c.notes = typeof c.notes === 'string' ? c.notes : ''; // заметки ГМ о персонаже: игрокам не уходят (getPublicState)
  c.position = map.defaultSpawn(getActiveLocation(), spawnOffset);
  c.locationPositions = {};
  spawnOffset += 1;
});

// Восстанавливаем сохранённые ресурсы/позицию персонажей поверх дефолтного
// спауна (см. persistRuntimeState) — только для тех, у кого есть снимок.
let notesMigrated = false;
if (initialRuntime && initialRuntime.characters) {
  characters.forEach((c) => {
    const saved = initialRuntime.characters[c.id];
    if (!saved) return;
    if (saved.hp != null) c.hp.current = saved.hp;
    if (saved.energy != null) c.energy.current = saved.energy;
    if (saved.resolve != null) c.resolve.current = saved.resolve;
    if (typeof saved.armor === 'number') c.armor = saved.armor;
    if (typeof saved.dead === 'boolean') c.dead = saved.dead;
    // Заметки раньше лежали в runtime.json (теперь — в roster.json): уже набранные подхватываем и переносим.
    if (typeof saved.notes === 'string' && saved.notes && !c.notes) { c.notes = saved.notes; notesMigrated = true; }
    if (saved.position) c.position = saved.position;
    c.locationPositions = saved.locationPositions || {};
  });
}
if (notesMigrated) saveRoster();

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

// Статус "убит": крестик поверх токена, метка ☠ в логе бросков и чате, запрет
// самостоятельного хода игроку (см. moveCharacter). Персистится в runtime.json
// вместе с остальным состоянием персонажа (persistRuntimeState).
function setCharacterDead(characterId, dead) {
  const c = findCharacter(characterId);
  if (!c) return;
  c.dead = !!dead;
}

// Для пометки ☠ у автора сообщений чата; ГМ/наблюдатель (characterId пуст) — не мёртв.
function isCharacterDead(characterId) {
  const c = characterId ? findCharacter(characterId) : null;
  return !!(c && c.dead);
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

// Скрытое имя: игроки видят вместо имени и роли hiddenName из настроек игры (маска — в
// getPublicState/publicCombat/publicDiceLog; настоящее имя остаётся в данных и у ГМ).
function setNpcNameHidden(npcId, hidden) {
  const n = findNpc(npcId);
  if (!n) return;
  n.nameHidden = !!hidden;
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
// Размер сетки ГМ не задаёт: карта бесконечная (см. map.isWalkable), а
// gridWidth/gridHeight — только «домашняя область» (спавн, стартовая камера).
function addLocation(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const id = slugifyId(trimmed, new Set(locations.map((l) => l.id)));
  const location = {
    id,
    name: trimmed.slice(0, config.LOCATION_NAME_MAX_LENGTH),
    gridWidth: config.DEFAULT_LOCATION_WIDTH,
    gridHeight: config.DEFAULT_LOCATION_HEIGHT,
  };
  locations.push(location);
  saveLocations();
  return location;
}

// Переставляет локацию на позицию toIndex (0-based) — порядок локаций это
// порядок массива locations. Возвращает true, если порядок изменился.
function moveLocation(locationId, toIndex) {
  const from = locations.findIndex((l) => l.id === locationId);
  const to = Number.isInteger(toIndex) ? clamp(toIndex, 0, locations.length - 1) : -1;
  if (from === -1 || to === -1 || from === to) return false;
  const [moved] = locations.splice(from, 1);
  locations.splice(to, 0, moved);
  saveLocations();
  return true;
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

// ---- Готовые картинки героев/NPC --------------------------------------------
// Две папки с одинаковыми адресами /avatars/presets/…: data/presets (кладёт ГМ — переживает пересборку
// Docker, главнее) и public/avatars/presets (поставляется с движком). Любой формат картинки; список
// строится по содержимому папок (положил файл — он появился в выборе), подписи и порядок — из
// необязательных manifest.json в этих папках. Имена файлов — латиница, цифры, «-», «_», «.»: так их
// безопасно подставлять в URL и проверять на сервере.
const BUNDLED_PRESETS_DIR = path.join(PUBLIC_DIR, 'avatars', 'presets');
const PRESET_DIRS = [USER_PRESETS_DIR, BUNDLED_PRESETS_DIR]; // порядок = приоритет при одинаковом имени
const PRESET_NAME_RE = /^[\w.-]+\.(svg|png|jpe?g|webp|gif)$/i;

// Допустимая «готовая» картинка: URL вида /avatars/presets/имя.расширение и такой файл есть в одной из папок.
function isAvatarPresetUrl(url) {
  if (typeof url !== 'string') return false;
  const m = /^\/avatars\/presets\/([^/]+)$/.exec(url);
  if (!m || !PRESET_NAME_RE.test(m[1])) return false;
  return PRESET_DIRS.some((dir) => {
    try {
      return fs.statSync(path.join(dir, m[1])).isFile();
    } catch (err) {
      return false;
    }
  });
}

// Список для выбора: [{ id, url, label }]. Сначала в порядке манифестов (свой — раньше поставляемого),
// затем остальные по алфавиту; подпись — из манифеста или имя файла без расширения.
function listAvatarPresets() {
  // «Показывать примеры из образа» выключено — в выборе только свои картинки (data/presets); уже
  // назначенные картинки из образа продолжают работать (isAvatarPresetUrl их по-прежнему знает).
  const dirs = gameConfig.get().showBundled === false ? [USER_PRESETS_DIR] : PRESET_DIRS;
  const fileSet = new Set();
  dirs.forEach((dir) => {
    try {
      fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && PRESET_NAME_RE.test(d.name))
        .forEach((d) => fileSet.add(d.name));
    } catch (err) { /* папки может не быть */ }
  });
  const files = [...fileSet];
  const manifest = [];
  dirs.forEach((dir) => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
      if (Array.isArray(raw)) raw.filter((e) => e && typeof e.url === 'string').forEach((e) => manifest.push(e));
    } catch (err) { /* манифест необязателен */ }
  });
  const byUrl = new Map();
  manifest.forEach((e) => { if (!byUrl.has(e.url)) byUrl.set(e.url, e); }); // раньше встреченный (свой) главнее
  const toItem = (name) => {
    const url = `/avatars/presets/${name}`;
    const base = name.replace(/\.[^.]+$/, '');
    const e = byUrl.get(url);
    // own — файл лежит в data/presets (его загрузил ГМ): такую картинку можно удалить из интерфейса
    return { id: (e && e.id) || base, url, label: (e && e.label) || base.replace(/[-_]+/g, ' '), own: fs.existsSync(path.join(USER_PRESETS_DIR, name)) };
  };
  const present = new Set(files);
  const ordered = [...new Set(manifest
    .map((e) => e.url.replace('/avatars/presets/', ''))
    .filter((name) => present.has(name)))];
  const rest = files.filter((name) => !ordered.includes(name)).sort((a, b) => a.localeCompare(b));
  return [...ordered, ...rest].map(toItem);
}

// ---- Свои готовые картинки (экран «Игра» → «Звуки»): загрузка и удаление ГМ -----------------------------
// Файл кладётся в data/presets (переживает пересборку Docker), подпись — в data/presets/manifest.json
// (тот же формат, что у поставляемого: [{ id, url, label }]; listAvatarPresets склеивает оба). Принимаем
// только растровые форматы: SVG с исполняемым содержимым открывался бы по прямой ссылке — файлы-SVG
// по-прежнему можно положить в папку руками. Картинка уже приведена клиентом к 128×128 PNG.
const PRESET_RASTER_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function readUserPresetManifest() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(USER_PRESETS_DIR, 'manifest.json'), 'utf-8'));
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e.url === 'string') : [];
  } catch (err) {
    return [];
  }
}

function writeUserPresetManifest(list) {
  writeFileAtomic(path.join(USER_PRESETS_DIR, 'manifest.json'), JSON.stringify(list, null, 2));
}

function saveUserPreset(name, dataUrl) {
  if (typeof dataUrl !== 'string') return { ok: false, reason: 'bad-format' };
  const match = PRESET_RASTER_RE.exec(dataUrl);
  if (!match) return { ok: false, reason: 'bad-format' };
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > config.AVATAR_UPLOAD_MAX_SIZE) return { ok: false, reason: 'too-large' };
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const label = (typeof name === 'string' ? name.replace(CONTROL_CHARS_RE, ' ').trim() : '').slice(0, config.AVATAR_PRESET_LABEL_MAX_LENGTH) || 'Картинка';
  if (listAvatarPresets().filter((p) => p.own).length >= config.AVATAR_PRESETS_MAX) return { ok: false, reason: 'limit' };
  const base = label.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 24) || 'avatar';
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
  const fileName = `${base}-${stamp}.${ext}`;
  try {
    fs.mkdirSync(USER_PRESETS_DIR, { recursive: true });
    fs.writeFileSync(path.join(USER_PRESETS_DIR, fileName), buffer);
    const url = `/avatars/presets/${fileName}`;
    writeUserPresetManifest([...readUserPresetManifest(), { id: `${base}-${stamp}`, url, label }]);
    return { ok: true, url };
  } catch (err) {
    console.warn('Не удалось сохранить картинку героя:', err.message);
    return { ok: false, reason: 'save-failed' };
  }
}

// Удаляет только СВОЮ картинку (из data/presets); поставляемые из образа удалить нельзя — их скрывает
// переключатель «Показывать примеры». Герои и NPC, которым она была назначена, возвращаются к букве-заглушке
// (если одноимённого файла в образе нет — иначе картинка осталась бы доступной по тому же адресу).
function removeUserPreset(url) {
  const m = typeof url === 'string' ? /^\/avatars\/presets\/([^/]+)$/.exec(url) : null;
  if (!m || !PRESET_NAME_RE.test(m[1])) return { ok: false, reason: 'not-found' };
  const file = path.join(USER_PRESETS_DIR, m[1]);
  if (!fs.existsSync(file)) return { ok: false, reason: 'not-found' };
  try {
    fs.unlinkSync(file);
    writeUserPresetManifest(readUserPresetManifest().filter((e) => e.url !== url));
  } catch (err) {
    console.warn('Не удалось удалить картинку героя:', err.message);
    return { ok: false, reason: 'save-failed' };
  }
  if (!fs.existsSync(path.join(BUNDLED_PRESETS_DIR, m[1]))) {
    characters.forEach((c) => { if (c.avatar === url) setCharacterAvatar(c.id, null); });
    npcs.forEach((n) => { if (n.avatar === url) setNpcAvatar(n.id, null); });
  }
  return { ok: true };
}

// ---- Звуки интерфейса (кубик, начало боя, заставка локации) --------------------------------------------
// Файл — в data/uploads/sfx, адрес /assets/sfx/<имя> записывается в настройки игры (sfx.<вид>); старый
// свой файл при замене и сбросе удаляется. Стандартные звуки лежат в образе (public/assets/sfx) и сюда не попадают.
function removeSfxFile(url) {
  if (typeof url !== 'string' || !url.startsWith('/assets/sfx/')) return;
  fs.unlink(path.join(SFX_DIR, path.basename(url)), (err) => {
    if (err && err.code !== 'ENOENT') console.warn('Не удалось удалить звук интерфейса:', err.message);
  });
}

function saveSfx(kind, dataUrl) {
  if (!gameConfig.SFX_KINDS.includes(kind)) return { ok: false, reason: 'invalid:sfx' };
  const match = typeof dataUrl === 'string' ? /^data:audio\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl) : null;
  const ext = match && AUDIO_EXT_BY_MIME[match[1]];
  if (!ext) return { ok: false, reason: 'bad-format' };
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > config.SFX_UPLOAD_MAX_SIZE) return { ok: false, reason: 'too-large' };
  const fileName = `${kind}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}.${ext}`;
  const prev = gameConfig.get().sfx[kind];
  try {
    fs.mkdirSync(SFX_DIR, { recursive: true });
    fs.writeFileSync(path.join(SFX_DIR, fileName), buffer);
  } catch (err) {
    console.warn('Не удалось сохранить звук интерфейса:', err.message);
    return { ok: false, reason: 'save-failed' };
  }
  const url = `/assets/sfx/${fileName}`;
  const result = gameConfig.update({ sfx: { [kind]: { url, volume: prev ? prev.volume : 1 } } });
  if (!result.ok) {
    fs.unlink(path.join(SFX_DIR, fileName), () => {});
    return result;
  }
  if (prev) removeSfxFile(prev.url);
  return { ok: true, url };
}

function resetSfx(kind) {
  if (!gameConfig.SFX_KINDS.includes(kind)) return { ok: false, reason: 'invalid:sfx' };
  const prev = gameConfig.get().sfx[kind];
  const result = gameConfig.update({ sfx: { [kind]: null } });
  if (result.ok && prev) removeSfxFile(prev.url);
  return result.ok ? { ok: true } : result;
}

// ---- Каталог навыков (экран «Игра» → «Подписи») --------------------------------------------------------
// skills.json: { "Название": { icon, description } }; героям навык выдаётся по названию, поэтому
// переименование и удаление проводятся по всем героям (и в roster.json). Порядок ключей = порядок в списках.
const RESERVED_SKILL_NAMES = ['__proto__', 'constructor', 'prototype'];

function saveSkillsFile() {
  try {
    writeFileAtomic(SKILLS_FILE, JSON.stringify(skillsCatalog, null, 2));
    return true;
  } catch (err) {
    console.warn('Не удалось сохранить skills.json:', err.message);
    return false;
  }
}

function saveSkill(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  if (!name || name.length > config.SKILL_NAME_MAX_LENGTH || CONTROL_CHARS_RE.test(name) || RESERVED_SKILL_NAMES.includes(name)) {
    return { ok: false, reason: 'invalid:name' };
  }
  if (!gameConfig.isKnownIcon(p.icon)) return { ok: false, reason: 'invalid:icon' };
  const description = typeof p.description === 'string' ? p.description.trim() : '';
  if (description.length > config.SKILL_DESCRIPTION_MAX_LENGTH || CONTROL_CHARS_RE.test(description.replace(/[\r\n\t]/g, ' '))) {
    return { ok: false, reason: 'invalid:description' };
  }
  const entry = { icon: p.icon, description };
  const oldName = typeof p.oldName === 'string' && p.oldName ? p.oldName : null;
  let renamed = false;

  if (oldName === null) {
    if (hasSkill(name)) return { ok: false, reason: 'exists' };
    if (Object.keys(skillsCatalog).length >= config.SKILLS_MAX) return { ok: false, reason: 'limit' };
    skillsCatalog[name] = entry;
  } else {
    if (!hasSkill(oldName)) return { ok: false, reason: 'not-found' };
    if (name === oldName) {
      skillsCatalog[name] = entry;
    } else {
      if (hasSkill(name)) return { ok: false, reason: 'exists' };
      // Переименование с сохранением места в списке: пересобираем объект на месте (на него держат ссылки).
      const entries = Object.entries(skillsCatalog);
      entries.forEach(([key]) => { delete skillsCatalog[key]; });
      entries.forEach(([key, value]) => { skillsCatalog[key === oldName ? name : key] = key === oldName ? entry : value; });
      characters.forEach((c) => {
        if (Array.isArray(c.skills)) c.skills = c.skills.map((s) => (s === oldName ? name : s));
      });
      renamed = true;
    }
  }
  if (!saveSkillsFile()) return { ok: false, reason: 'save-failed' };
  if (renamed) saveRoster();
  return { ok: true };
}

function removeSkill(name) {
  if (typeof name !== 'string' || !hasSkill(name)) return { ok: false, reason: 'not-found' };
  delete skillsCatalog[name];
  characters.forEach((c) => {
    if (Array.isArray(c.skills)) c.skills = c.skills.filter((s) => s !== name);
  });
  if (!saveSkillsFile()) return { ok: false, reason: 'save-failed' };
  saveRoster();
  return { ok: true };
}

// Список музыки сократился (скрыли примеры из образа), а играл скрытый трек — выключаем: иначе он продолжал
// бы играть, хотя в списке его уже нет. Возвращает true, если музыка остановлена.
function stopMusicIfTrackGone() {
  const id = state.music.trackId;
  if (id === null || id === undefined) return false;
  if (listAudio('music').some((e) => e.id === id)) return false;
  stopMusic();
  return true;
}

// Сохраняет назначение аватара персонажу и персистит его в avatars.json,
// чтобы выбор пережил перезапуск сервера. url = null — убрать (останется буква-заглушка).
function setCharacterAvatar(characterId, url) {
  const c = findCharacter(characterId);
  if (!c) return;
  c.avatar = url || null;
  if (url) avatarAssignments[characterId] = url; else delete avatarAssignments[characterId];
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
  const fileName = uploadFileName(characterId, ext);
  fs.writeFileSync(path.join(UPLOADS_DIR, fileName), buffer);
  const url = `/avatars/uploads/${fileName}`;
  setCharacterAvatar(characterId, url);
  return url;
}

// Имя файла загруженной картинки — только латиница/цифры (id героя может быть кириллицей:
// такое имя в URL и в avatars.json только путало бы) + время и случайный хвост против коллизий.
function uploadFileName(ownerId, ext) {
  const safe = String(ownerId).replace(/[^a-z0-9]+/gi, '').slice(0, 24) || 'avatar';
  return `${safe}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
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
  const fileName = uploadFileName(npcId, ext);
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
  saveRoster();
}

function removeItem(characterId, index) {
  const c = findCharacter(characterId);
  if (!c || !Array.isArray(c.inventory)) return;
  if (index < 0 || index >= c.inventory.length) return;
  c.inventory.splice(index, 1);
  saveRoster();
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

// Добавляет нового персонажа во время сессии (Vue-панель «Участники»). Определение пишется
// в roster.json (saveRoster), characters.json не трогаем — персонаж переживает перезапуск сервера.
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
    notes: '',
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
  saveRoster();
  return character;
}

// Удаляет персонажа безвозвратно из состава (roster.json); characters.json не трогаем.
function removeCharacter(characterId) {
  const idx = characters.findIndex((c) => c.id === characterId);
  if (idx === -1) return;
  characters.splice(idx, 1);
  saveRoster();
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

// Редактирование данных персонажа из диалога «Инфо» (имя/титул/завязка/предыстория/заметки/
// навыки/атрибуты) — сохраняется в roster.json (saveRoster), characters.json не трогаем.
// HP/энергия/решимость/броня/код/dead сюда не входят — у них свои узкие хендлеры, а
// инвентарь меняют giveItem/removeItem (они тоже пишут roster.json).
function updateCharacter(characterId, data) {
  const character = findCharacter(characterId);
  if (!character) return;
  if (typeof data?.name === 'string' && data.name.trim()) character.name = data.name.trim();
  if (typeof data?.title === 'string') character.title = data.title.trim();
  if (typeof data?.hook === 'string') character.hook = data.hook.trim();
  if (typeof data?.backstory === 'string') character.backstory = data.backstory.trim();
  if (typeof data?.notes === 'string') character.notes = data.notes.trim(); // только ГМ (getPublicState их не отдаёт)
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
  saveRoster();
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
// проверка проходимости, без энергии) — энергобюджет и достижимость по
// энергии действуют только во время боя, и только в свой ход по инициативе.
// Убитый персонаж сам не ходит (ГМ может переставить его через forceMoveCharacter).
function moveCharacter(characterId, target) {
  const c = findCharacter(characterId);
  if (!c) return { ok: false, reason: 'unknown-character' };
  if (c.dead) return { ok: false, reason: 'dead' };

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

// ---- Пасхалка: молния отбрасывает фишку игрока ------------------------------
// Молния попала в точку (x, y) — мировые px, как у токенов: клетка = floor(x / CELL_SIZE), floor((y − 20) / CELL_SIZE).
// Бьёт по клетке: каждый живой персонаж в ней (NPC не трогаем) отлетает на одну клетку в случайную из 8 сторон.
// HP, энергия и ход в бою не меняются. Сначала план (направление выбирает сервер — у всех клиентов анимация
// одна), через LIGHTNING_HIT_DELAY_MS — применение (см. vfx:trigger в index.js).
const lightningKnockUntil = new Map(); // id персонажа -> время (мс), до которого его снова не отбрасываем

function planLightningHits(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
  const cx = Math.floor(x / config.CELL_SIZE);
  const cy = Math.floor((y - 20) / config.CELL_SIZE);
  const now = Date.now();
  const location = getActiveLocation();
  const hits = [];
  characters.forEach((c) => {
    if (c.dead || !c.position || c.position.x !== cx || c.position.y !== cy) return;
    if ((lightningKnockUntil.get(c.id) || 0) > now) return;
    const dirs = config.LIGHTNING_KNOCK_DIRS.filter((d) => map.isWalkable(location, cx + d.dx, cy + d.dy));
    if (!dirs.length) return;
    const d = dirs[Math.floor(Math.random() * dirs.length)];
    lightningKnockUntil.set(c.id, now + config.LIGHTNING_KNOCK_COOLDOWN_MS);
    hits.push({ id: c.id, from: { x: cx, y: cy }, to: { x: cx + d.dx, y: cy + d.dy } });
  });
  return hits;
}

// Применяет отлёты из плана. Персонаж, которого за время задержки переставили (ГМ, смена локации) или убили, не
// трогаем — иначе его «вернуло» бы назад. true — кто-то сдвинулся (нужна рассылка state).
function applyLightningHits(hits) {
  let moved = false;
  (Array.isArray(hits) ? hits : []).forEach((h) => {
    const c = h && h.from && h.to && findCharacter(h.id);
    if (!c || c.dead || !c.position || c.position.x !== h.from.x || c.position.y !== h.from.y) return;
    if (!map.isWalkable(getActiveLocation(), h.to.x, h.to.y)) return;
    c.position = { x: h.to.x, y: h.to.y };
    moved = true;
  });
  return moved;
}

// Подсветка достижимых клеток нужна только в бою (вне боя перемещение
// свободное — см. moveCharacter, клиент не гейтит тап по reachable).
function getReachableCells(characterId) {
  if (!state.combat.active) return [];
  const c = findCharacter(characterId);
  if (!c || c.dead) return [];
  const turn = state.combat.order[state.combat.currentIndex];
  if (!turn || turn.type !== 'character' || turn.id !== characterId) return [];
  const reachable = map.findReachable(getActiveLocation(), c.position, c.energy.current);
  return Array.from(reachable.entries()).map(([key, cost]) => {
    const [x, y] = key.split(',').map(Number);
    return { x, y, cost };
  });
}

// Место падения кубика на экране (доли 0..1) и параметры траектории. Из
// нескольких случайных точек берём самую удалённую от кубиков, которые ещё
// лежат на экране (младше DICE_THROW_RECENT_MS), — чтобы кубики параллельных
// бросков не налезали друг на друга. Выбирает сервер, поэтому у ГМ и всех
// игроков кубик лежит в одном и том же месте.
function pickDiceThrow() {
  const now = Date.now();
  const recent = state.diceLog
    .filter((e) => e.throw && now - new Date(e.time).getTime() < config.DICE_THROW_RECENT_MS)
    .map((e) => e.throw);
  const rnd = (min, max) => min + Math.random() * (max - min);
  let best = null;
  let bestDist = -1;
  for (let i = 0; i < config.DICE_THROW_CANDIDATES; i++) {
    const p = {
      x: rnd(config.DICE_THROW_X_MIN, config.DICE_THROW_X_MAX),
      y: rnd(config.DICE_THROW_Y_MIN, config.DICE_THROW_Y_MAX),
    };
    const dist = recent.length ? Math.min(...recent.map((r) => Math.hypot(r.x - p.x, r.y - p.y))) : Infinity;
    if (dist > bestDist) { best = p; bestDist = dist; }
  }
  return {
    x: Math.round(best.x * 1000) / 1000,
    y: Math.round(best.y * 1000) / 1000,
    from: Math.floor(Math.random() * 4), // с какого края экрана влетает: 0 слева, 1 справа, 2 сверху, 3 снизу
    seed: Math.floor(Math.random() * 1e9), // от него клиент считает отскоки/вращение — одинаково у всех
  };
}

// DC берётся из текущего значения, заданного мастером (не с клиента).
// spendResolve: если true и Решимости хватает на цену бонуса — списать её и добавить бонус к сумме
// (цена и размер бонуса — check.bonus в настройках игры; по умолчанию −1 → +2).
// label: имя для лога, когда бросок не привязан к персонажу (свободный бросок мастера).
// Кто бросает: персонаж, NPC или мастер (id нет в справочниках) — общие поля записи лога
// для rollDice и rollDamage. NPC не имеют Решимости, но имеют те же атрибуты — id
// персонажей и NPC не пересекаются, поэтому безопасно проверить оба справочника по одному id.
function describeRoller(characterId, label) {
  const c = findCharacter(characterId);
  const n = !c ? findNpc(characterId) : null;
  const entity = c || n;
  return {
    c,
    n,
    entity,
    fields: {
      characterId,
      characterName: entity ? entity.name : (label || 'Мастер'),
      dead: !!(entity && entity.dead), // бросает убитый — клиент помечает имя ☠
      // Кто бросает и каким цветом рисовать его кубик (у скрытого NPC нет записи
      // в публичном state — клиенту проще получить цвет прямо из записи лога).
      kind: c ? 'character' : n ? 'npc' : 'gm',
      color: c ? (c.color || '#888888') : n ? config.DICE_COLOR_NPC : config.DICE_COLOR_GM,
    },
  };
}

function pushDiceLog(entry) {
  state.diceLog.unshift(entry);
  state.diceLog = state.diceLog.slice(0, 30);
  return entry;
}

// Кубик урона dN (N из настроек игры — check.damageDice): просто показывается всем кубиком на экране и
// записью лога, HP не меняет — урон применяет ГМ на карточке цели (applyDamage, броня учтена).
function rollDamage(characterId, sides, label) {
  if (!gameConfig.get().check.damageDice.includes(sides)) return null;
  const { fields } = describeRoller(characterId, label);
  const die = Math.floor(Math.random() * sides) + 1;
  return pushDiceLog({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...fields,
    throw: pickDiceThrow(),
    type: 'damage',
    sides,
    attribute: null,
    die,
    total: die,
    dc: null,
    success: null,
    critical: null,
    time: new Date().toISOString(),
  });
}

function rollDice(characterId, attribute, spendResolve, label) {
  const { c, entity, fields } = describeRoller(characterId, label);
  const attrValue = entity && entity.attributes && entity.attributes[attribute] !== undefined ? entity.attributes[attribute] : 0;
  // Кубик, пороги критов, цена и размер бонуса — из настроек игры (check): по умолчанию d20, крит 20/1, −1 → +2.
  const check = gameConfig.get().check;
  const die = Math.floor(Math.random() * check.die) + 1;

  let resolveBonus = 0;
  if (spendResolve && c && c.resolve.current >= check.bonus.cost) {
    c.resolve.current = clamp(c.resolve.current - check.bonus.cost, 0, c.resolve.max);
    resolveBonus = check.bonus.amount;
  }

  const dc = state.currentDc;
  const total = die + attrValue + resolveBonus;
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...fields,
    throw: pickDiceThrow(),
    sides: check.die, // форма кубика на экране (diceFx.js); у кубика урона sides — свой (type: 'damage')
    attribute,
    die,
    attrValue,
    resolveBonus,
    total,
    dc: dc || null,
    success: dc ? total >= dc : null,
    critical: check.critSuccess !== null && die >= check.critSuccess ? 'success'
      : check.critFail !== null && die <= check.critFail ? 'fail' : null,
    time: new Date().toISOString(),
  };
  return pushDiceLog(entry);
}

function clearDiceLog() {
  state.diceLog = [];
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
  const rollsStr = rolls.join(' + '); // без эмодзи: иконки интерфейса — отдельная система (public/js/icons.js)
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

// ---- Погода на экране -----------------------------------------------------
// Значение из runtime.json/клиента приводим к допустимому: неизвестный режим или
// интенсивность заменяем значениями по умолчанию из config (функция объявлена
// через function — state выше инициализируется ею).
function normalizeWeather(raw) {
  const def = config.WEATHER_DEFAULT;
  const mode = raw && config.WEATHER_MODES.includes(raw.mode) ? raw.mode : def.mode;
  const intensity = raw && config.WEATHER_INTENSITIES.includes(raw.intensity) ? raw.intensity : def.intensity;
  return { mode, intensity };
}

// Меняет погоду (только мастер — гейт в index.js). Поля, которых нет в patch или
// которые невалидны, остаются прежними; возвращает true, если что-то изменилось.
function setWeather(patch) {
  const p = patch || {};
  const next = {
    mode: config.WEATHER_MODES.includes(p.mode) ? p.mode : state.weather.mode,
    intensity: config.WEATHER_INTENSITIES.includes(p.intensity) ? p.intensity : state.weather.intensity,
  };
  if (next.mode === state.weather.mode && next.intensity === state.weather.intensity) return false;
  state.weather = next;
  return true;
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
// Список звуков/треков, который клиент (soundboard.js/music.js) читает по адресам
// assets/sounds|music/manifest.json, собирает сервер (listAudio): поставляемые с движком записи
// (public/assets/<вид>/manifest.json, только чтение) минус скрытые ГМ плюс добавленные ГМ.
// Добавленное и скрытое — в data/audio-library.json, загруженные файлы — в data/uploads/<вид>/ (то есть
// переживают пересборку Docker); index.js отдаёт манифест и файлы под прежними адресами.
// Декодирование dataURL — тот же принцип, что у addMapImage, но для audio/*.
const AUDIO_KINDS = ['music', 'sounds'];
const AUDIO_EXT_BY_MIME = { mpeg: 'mp3', wav: 'wav', 'x-wav': 'wav', ogg: 'ogg' };

function readManifest(file) {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

function loadAudioLibrary() {
  let raw = null;
  for (const file of [AUDIO_LIBRARY_FILE, `${AUDIO_LIBRARY_FILE}.bak`]) {
    if (!fs.existsSync(file)) continue;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (raw && typeof raw === 'object') break;
    } catch (err) {
      console.error(`Не удалось прочитать ${path.basename(file)}:`, err.message);
      raw = null;
    }
  }
  const lib = {};
  AUDIO_KINDS.forEach((kind) => {
    const part = (raw && raw[kind]) || {};
    lib[kind] = {
      added: (Array.isArray(part.added) ? part.added : [])
        .filter((e) => e && typeof e.id === 'string' && typeof e.file === 'string'),
      removed: (Array.isArray(part.removed) ? part.removed : []).filter((s) => typeof s === 'string'),
    };
  });
  return lib;
}
const audioLibrary = loadAudioLibrary();

function saveAudioLibrary() {
  try {
    writeFileAtomic(AUDIO_LIBRARY_FILE, JSON.stringify(audioLibrary, null, 2));
  } catch (err) {
    console.warn('Не удалось сохранить audio-library.json:', err.message);
  }
}

const bundledAudio = (kind) => readManifest(path.join(PUBLIC_DIR, 'assets', kind, 'manifest.json'));

// Итоговый список для клиента (kind: 'music' | 'sounds').
function listAudio(kind) {
  const lib = audioLibrary[kind];
  if (!lib) return [];
  // «Показывать примеры из образа» выключено — только то, что добавил ГМ.
  const bundled = gameConfig.get().showBundled === false ? [] : bundledAudio(kind).filter((e) => !lib.removed.includes(e.id));
  return [...bundled, ...lib.added];
}

function addAudioEntry(kind, maxSize, name, dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:audio\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  const ext = AUDIO_EXT_BY_MIME[match[1]];
  if (!ext) return null; // неподдерживаемый формат — принимаем только mp3/wav/ogg
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > maxSize) return null; // защита от гигантских файлов
  const dir = AUDIO_UPLOAD_DIRS[kind];
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fileName = `${id}.${ext}`;
  fs.writeFileSync(path.join(dir, fileName), buffer);
  const label = (typeof name === 'string' && name.trim() ? name.trim() : id).slice(0, config.AUDIO_LABEL_MAX_LENGTH);
  const entry = { id, label, file: fileName };
  audioLibrary[kind].added.push(entry);
  saveAudioLibrary();
  return entry;
}

// Добавленную ГМ запись удаляем вместе с файлом; поставляемую с движком — только скрываем
// (файл лежит в образе и стереть его нельзя), скрытие хранится в audio-library.json.
function removeAudioEntry(kind, id) {
  const lib = audioLibrary[kind];
  const idx = lib.added.findIndex((e) => e.id === id);
  if (idx !== -1) {
    const [removed] = lib.added.splice(idx, 1);
    saveAudioLibrary();
    if (removed.file) {
      fs.unlink(path.join(AUDIO_UPLOAD_DIRS[kind], path.basename(removed.file)), (err) => {
        if (err && err.code !== 'ENOENT') console.warn('Не удалось удалить аудиофайл:', err.message);
      });
    }
    return true;
  }
  if (!lib.removed.includes(id) && bundledAudio(kind).some((e) => e.id === id)) {
    lib.removed.push(id);
    saveAudioLibrary();
    return true;
  }
  return false;
}

function addSound(name, dataUrl) {
  return addAudioEntry('sounds', config.SOUND_UPLOAD_MAX_SIZE, name, dataUrl);
}

function removeSound(id) {
  return removeAudioEntry('sounds', id);
}

function addMusicTrack(name, dataUrl) {
  return addAudioEntry('music', config.MUSIC_UPLOAD_MAX_SIZE, name, dataUrl);
}

function removeMusicTrack(id) {
  const removed = removeAudioEntry('music', id);
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
// каталога UPLOADS_DIR персонажей — файлы кладём в отдельную папку map-images (data/uploads/map-images).

function findMapImage(id) {
  return state.mapImages.find((m) => m.id === id);
}

// Геометрия картинки. К `scale` (общий масштаб) добавлены необязательные поля — у старых картинок их нет и всё
// считается как раньше: `stretchX/stretchY` (растяжение по одной оси, множитель поверх scale) и
// `crop: { l, t, r, b }` (доли натурального размера, обрезанные слева/сверху/справа/снизу; хранятся в осях исходного
// файла). `x/y` — центр ВИДИМОЙ части. Та же формула — `imageBox` в public/js/map.js.
function imageVisibleSize(m) {
  const c = m.crop || {};
  return {
    w: m.naturalWidth * (1 - (c.l || 0) - (c.r || 0)) * m.scale * (m.stretchX || 1),
    h: m.naturalHeight * (1 - (c.t || 0) - (c.b || 0)) * m.scale * (m.stretchY || 1),
  };
}

// Применяет к картинке stretchX/stretchY/crop из patch. Строго: не число, вне диапазона, объект не той формы —
// поле не меняется (процесс не падает). Единичное растяжение и нулевая обрезка (или null) удаляют поле.
function applyImageGeometry(m, p) {
  ['stretchX', 'stretchY'].forEach((key) => {
    if (!(key in p)) return;
    const v = p[key];
    if (v === null) { delete m[key]; return; }
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return;
    const k = clamp(v, config.MAP_IMAGE_STRETCH_MIN, config.MAP_IMAGE_STRETCH_MAX);
    if (Math.abs(k - 1) < 1e-4) delete m[key]; else m[key] = Math.round(k * 10000) / 10000;
  });
  if ('crop' in p) {
    const c = p.crop;
    if (c === null) { delete m.crop; return; }
    if (!c || typeof c !== 'object' || Array.isArray(c)) return;
    const side = (v) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1 - config.MAP_IMAGE_CROP_MIN_VISIBLE) : null);
    let l = side(c.l); let t = side(c.t); let r = side(c.r); let b = side(c.b);
    if (l === null || t === null || r === null || b === null) return;
    // сумма двух противоположных обрезок оставляет видимой не меньше CROP_MIN_VISIBLE: лишнее срезаем пропорционально
    const maxSum = 1 - config.MAP_IMAGE_CROP_MIN_VISIBLE;
    if (l + r > maxSum) { const k = maxSum / (l + r); l *= k; r *= k; }
    if (t + b > maxSum) { const k = maxSum / (t + b); t *= k; b *= k; }
    const round = (v) => Math.round(v * 10000) / 10000;
    l = round(l); t = round(t); r = round(r); b = round(b);
    if (!l && !t && !r && !b) delete m.crop; else m.crop = { l, t, r, b };
  }
}

// Потолок видимой стороны для картинки игрока: обрезка/растяжение не должны обходить PLAYER_IMAGE_MAX_SIDE_PX
// (иначе камера у всех растянулась бы) — лишнее срезаем общим масштабом.
function clampPlayerImageSize(m) {
  const { w, h } = imageVisibleSize(m);
  const side = Math.max(w, h);
  if (side > config.PLAYER_IMAGE_MAX_SIDE_PX) m.scale = Math.max(0.05, m.scale * (config.PLAYER_IMAGE_MAX_SIDE_PX / side));
}

// Разбор data URL картинки: { ok: true, ext, buffer } или { ok: false, reason }.
// reason: 'invalid' (не картинка/битый формат) | 'too-large' (> MAP_IMAGE_UPLOAD_MAX_SIZE).
// Общий для загрузки ГМ (addMapImage) и предложений игроков (proposeMapImage).
function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return { ok: false, reason: 'invalid' };
  const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return { ok: false, reason: 'invalid' };
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > config.MAP_IMAGE_UPLOAD_MAX_SIZE) return { ok: false, reason: 'too-large' }; // защита от гигантских картинок
  return { ok: true, ext: match[1] === 'jpeg' ? 'jpg' : match[1], buffer };
}

// naturalWidth/naturalHeight — реальный размер файла (клиент вычисляет
// перед отправкой); позиция по умолчанию — центр карты. name — исходное
// имя загруженного файла (для отображения в списке картинок на панели ГМ).
// x/y — опциональная позиция размещения (например, центр текущего вьюпорта
// ГМ на момент загрузки, см. mapController.getCameraCenter() в
// MapToolsPanel.vue); при отсутствии/невалидности — фолбэк на центр карты,
// как раньше.
function addMapImage(dataUrl, naturalWidth, naturalHeight, name, x, y) {
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed.ok) return null;
  const w = Number(naturalWidth);
  const h = Number(naturalHeight);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  // Размер приходит от клиента (он сжимает до 1600) — не доверяем: огромные
  // значения растянули бы рамку/границы камеры у всех.
  if (w > config.MAP_IMAGE_MAX_NATURAL_SIDE || h > config.MAP_IMAGE_MAX_NATURAL_SIDE) return null;
  const { ext, buffer } = parsed;
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
  if (Number.isFinite(patch.x)) m.x = patch.x;
  if (Number.isFinite(patch.y)) m.y = patch.y;
  if (Number.isFinite(patch.scale) && patch.scale > 0) m.scale = clamp(patch.scale, 0.05, 10);
  if (Number.isFinite(patch.rotation)) m.rotation = patch.rotation;
  if (typeof patch.flipX === 'boolean') m.flipX = patch.flipX;
  if (typeof patch.flipY === 'boolean') m.flipY = patch.flipY;
  if (typeof patch.locked === 'boolean') m.locked = patch.locked;
  applyImageGeometry(m, patch);
  return m;
}

// Порядок слоёв = порядок картинок в state.mapImages (первая — самая нижняя, рисуется
// первой; под клик попадает последняя). op: 'front'/'back' — в конец/начало массива,
// 'up'/'down' — меняет местами с ближайшей картинкой ТОЙ ЖЕ локации (картинки других
// локаций между ними не в счёт). Возвращает true, если порядок изменился.
const MAP_IMAGE_REORDER_OPS = ['front', 'up', 'down', 'back'];
function reorderMapImage(id, op) {
  if (!MAP_IMAGE_REORDER_OPS.includes(op)) return false;
  const list = state.mapImages;
  const from = list.findIndex((m) => m.id === id);
  if (from === -1) return false;
  const item = list[from];
  if (op === 'front' || op === 'back') {
    const sameLocation = list.filter((m) => m.locationId === item.locationId);
    const edge = op === 'front' ? sameLocation[sameLocation.length - 1] : sameLocation[0];
    if (edge === item) return false; // уже на краю
    list.splice(from, 1);
    if (op === 'front') list.push(item); else list.unshift(item);
    return true;
  }
  const step = op === 'up' ? 1 : -1;
  let to = from + step;
  while (to >= 0 && to < list.length && list[to].locationId !== item.locationId) to += step;
  if (to < 0 || to >= list.length) return false; // выше/ниже некуда
  [list[from], list[to]] = [list[to], list[from]];
  return true;
}

// Окрестность «домашней области» локации (gridWidth×gridHeight клеток + запас):
// владелец-игрок не уносит картинку дальше — иначе камера у всех растянулась бы, а
// «Скрыть всё» у ГМ перебирало бы клетки тумана по огромной площади.
function clampImagePosition(location, x, y) {
  const margin = config.PLAYER_IMAGE_MARGIN_PX;
  const maxX = location.gridWidth * config.CELL_SIZE + margin;
  const maxY = location.gridHeight * config.CELL_SIZE + 20 + margin;
  return { x: clamp(x, -margin, maxX), y: clamp(y, 20 - margin, maxY) };
}

// Проверка владения для правки/удаления картинки игроком: своя (ownerId), не
// заблокирована ГМ (locked) и лежит на активной локации. { ok, entry } | { ok: false, reason }.
function checkOwnedMapImage(id, characterId) {
  const m = findMapImage(id);
  if (!m || !characterId || m.ownerId !== characterId) return { ok: false, reason: 'forbidden' };
  if (m.locked) return { ok: false, reason: 'locked' };
  if (m.locationId !== state.activeLocationId) return { ok: false, reason: 'wrong-location' };
  return { ok: true, entry: m };
}

// Игрок правит СВОЮ картинку. В patch берём только x/y/scale/rotation/flip/stretch/crop — locked
// игрок менять не может; масштаб, размер и позиция ограничены (см. config.PLAYER_IMAGE_*).
function updateOwnedMapImage(id, characterId, patch) {
  const check = checkOwnedMapImage(id, characterId);
  if (!check.ok) return check;
  const m = check.entry;
  const p = patch || {};
  if (Number.isFinite(p.scale) && p.scale > 0) {
    const maxScale = config.PLAYER_IMAGE_MAX_SIDE_PX / Math.max(m.naturalWidth, m.naturalHeight);
    m.scale = clamp(p.scale, 0.05, Math.min(10, maxScale));
  }
  applyImageGeometry(m, p);
  clampPlayerImageSize(m);
  if (Number.isFinite(p.x) || Number.isFinite(p.y)) {
    const pos = clampImagePosition(
      findLocation(m.locationId) || getActiveLocation(),
      Number.isFinite(p.x) ? p.x : m.x,
      Number.isFinite(p.y) ? p.y : m.y,
    );
    m.x = pos.x;
    m.y = pos.y;
  }
  if (Number.isFinite(p.rotation)) m.rotation = p.rotation;
  if (typeof p.flipX === 'boolean') m.flipX = p.flipX;
  if (typeof p.flipY === 'boolean') m.flipY = p.flipY;
  return { ok: true, entry: m };
}

// Игрок меняет слой СВОЕЙ картинки (среди всех картинок активной локации): те же
// условия, что у правки — своя, не заблокирована ГМ, активная локация.
function reorderOwnedMapImage(id, characterId, op) {
  const check = checkOwnedMapImage(id, characterId);
  if (!check.ok) return check;
  if (!MAP_IMAGE_REORDER_OPS.includes(op)) return { ok: false, reason: 'invalid' };
  reorderMapImage(id, op);
  return { ok: true, entry: check.entry };
}

function removeOwnedMapImage(id, characterId) {
  const check = checkOwnedMapImage(id, characterId);
  if (!check.ok) return check;
  removeMapImage(id);
  return { ok: true };
}

// Дубликат картинки: тот же файл (url общий — removeMapImage стирает файл, только когда на него никто не
// ссылается), копия геометрии (поворот, отражение, обрезка, растяжение), сдвиг на клетку, поверх всех слоёв,
// не заблокирована. actor: { gm: true } — любая картинка, копия без владельца; { characterId } — только своя
// (те же проверки, что у правки) и в пределах MAX_MAP_IMAGES_PER_PLAYER, копия тоже его.
// { ok: true, entry } | { ok: false, reason }.
function duplicateMapImage(id, actor) {
  const src = findMapImage(id);
  if (!src) return { ok: false, reason: 'unknown' };
  const player = actor && actor.characterId ? actor.characterId : null;
  if (player) {
    const check = checkOwnedMapImage(id, player);
    if (!check.ok) return check;
    const owned = state.mapImages.filter((m) => m.ownerId === player).length;
    if (owned >= config.MAX_MAP_IMAGES_PER_PLAYER) return { ok: false, reason: 'limit-reached' };
  } else if (!actor || !actor.gm) {
    return { ok: false, reason: 'forbidden' };
  }
  const entry = JSON.parse(JSON.stringify(src));
  entry.id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const suffix = ' (копия)';
  const base = typeof src.name === 'string' ? src.name : '';
  entry.name = !base ? 'Копия' : (base.endsWith(suffix) ? base : (base + suffix)).slice(0, config.MAP_IMAGE_NAME_MAX_LENGTH);
  entry.locked = false;
  if (player) {
    entry.ownerId = src.ownerId;
    entry.ownerName = src.ownerName;
  } else {
    delete entry.ownerId;
    delete entry.ownerName;
  }
  let x = src.x + config.CELL_SIZE;
  let y = src.y + config.CELL_SIZE;
  if (player) {
    const pos = clampImagePosition(findLocation(src.locationId) || getActiveLocation(), x, y);
    x = pos.x;
    y = pos.y;
  }
  entry.x = x;
  entry.y = y;
  state.mapImages.push(entry);
  return { ok: true, entry };
}

function removeMapImage(id) {
  const idx = state.mapImages.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  const [removed] = state.mapImages.splice(idx, 1);
  // Файл может быть общим у нескольких картинок (дубликаты) — стираем, только когда ссылок не осталось.
  if (removed && removed.url && !state.mapImages.some((m) => m.url === removed.url)) {
    // Файл лежит в data/uploads/map-images (старые — ещё в public/avatars/map-images, если не перенесены).
    const name = path.basename(removed.url);
    [MAP_IMAGES_DIR, path.join(PUBLIC_DIR, 'avatars', 'map-images')].forEach((dir) => {
      fs.unlink(path.join(dir, name), (err) => {
        if (err && err.code !== 'ENOENT') console.warn('Не удалось удалить файл картинки карты:', err.message);
      });
    });
  }
  return true;
}

// ---- Предложения картинок от игроков ------------------------------------
// Игрок вставляет картинку (Ctrl+V) — она не попадает на карту, пока ГМ не
// нажмёт «Принять». Предложения хранятся ТОЛЬКО в памяти (не в state и не в
// runtime.json): base64-картинка до 5 МБ раздула бы каждый broadcast, а на
// диск файл пишется лишь при принятии (addMapImage). Рестарт сервера очищает
// очередь — это допустимо, игрок может вставить заново.
const pendingImageProposals = new Map(); // id -> предложение
const lastProposalAt = new Map();        // characterId -> время последнего предложения (кулдаун)

// Убирает просроченные предложения и возвращает их (чтобы index.js уведомил
// авторов и ГМ).
function pruneImageProposals() {
  const now = Date.now();
  const expired = [];
  pendingImageProposals.forEach((p, id) => {
    if (now - p.createdAt > config.IMAGE_PROPOSAL_TTL_MS) {
      pendingImageProposals.delete(id);
      expired.push(p);
    }
  });
  return expired;
}

// Принимает предложение игрока в очередь. Возвращает { ok: true, proposal } или
// { ok: false, reason }: 'invalid' | 'too-large' | 'pending-exists' | 'limit-reached' | 'cooldown' | 'too-many'.
function proposeMapImage(characterId, authorName, payload) {
  const { dataUrl, naturalWidth, naturalHeight, name, x, y, scale } = payload || {};
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const w = Number(naturalWidth);
  const h = Number(naturalHeight);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { ok: false, reason: 'invalid' };
  if (w > config.MAP_IMAGE_MAX_NATURAL_SIDE || h > config.MAP_IMAGE_MAX_NATURAL_SIDE) return { ok: false, reason: 'invalid' };
  for (const p of pendingImageProposals.values()) {
    if (p.characterId === characterId) return { ok: false, reason: 'pending-exists' };
  }
  // Лимит картинок игрока — по всем локациям: файлы лежат на диске, пока их не удалят.
  const owned = state.mapImages.filter((m) => m.ownerId === characterId).length;
  if (owned >= config.MAX_MAP_IMAGES_PER_PLAYER) return { ok: false, reason: 'limit-reached' };
  const now = Date.now();
  if (now - (lastProposalAt.get(characterId) || 0) < config.IMAGE_PROPOSAL_COOLDOWN_MS) return { ok: false, reason: 'cooldown' };
  if (pendingImageProposals.size >= config.MAX_PENDING_IMAGE_PROPOSALS) return { ok: false, reason: 'too-many' };
  const posX = Number(x);
  const posY = Number(y);
  // Позиция — где игрок смотрел в момент вставки (в окрестности домашней области
  // локации); нет/мусор — addMapImage поставит в центр карты.
  const pos = Number.isFinite(posX) && Number.isFinite(posY) ? clampImagePosition(getActiveLocation(), posX, posY) : null;
  // Начальный масштаб подбирает клиент игрока (чтобы картинка влезла в часть экрана,
  // а не ложилась в натуральную величину); сервер ограничивает его тем же потолком,
  // что и дальнейшую правку владельцем.
  const rawScale = Number(scale);
  const maxScale = Math.min(10, config.PLAYER_IMAGE_MAX_SIDE_PX / Math.max(w, h));
  const proposal = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    dataUrl,
    naturalWidth: w,
    naturalHeight: h,
    name: typeof name === 'string' ? name.trim().slice(0, config.MAP_IMAGE_NAME_MAX_LENGTH) : '',
    x: pos ? pos.x : undefined,
    y: pos ? pos.y : undefined,
    scale: Number.isFinite(rawScale) && rawScale > 0 ? clamp(rawScale, 0.05, maxScale) : Math.min(1, maxScale),
    characterId,
    authorName: String(authorName || 'Игрок').slice(0, 60),
    createdAt: now,
  };
  pendingImageProposals.set(proposal.id, proposal);
  lastProposalAt.set(characterId, now);
  return { ok: true, proposal };
}

function listImageProposals() {
  return Array.from(pendingImageProposals.values());
}

// ГМ принял предложение: картинка попадает на карту АКТИВНОЙ локации (при
// смене сцены очередь сбрасывается, см. clearImageProposals). { ok, entry, proposal } | { ok: false, reason }.
function approveImageProposal(id) {
  const proposal = pendingImageProposals.get(id);
  if (!proposal) return { ok: false, reason: 'unknown' };
  const entry = addMapImage(proposal.dataUrl, proposal.naturalWidth, proposal.naturalHeight, proposal.name || 'Вставка', proposal.x, proposal.y);
  if (!entry) return { ok: false, reason: 'invalid' };
  // Владелец — игрок-автор: дальше сам двигает/масштабирует/удаляет картинку
  // (updateOwnedMapImage), пока ГМ не заблокирует 🔒. ownerName показывает ГМ в списке картинок.
  entry.ownerId = proposal.characterId;
  entry.ownerName = proposal.authorName;
  entry.scale = proposal.scale;
  pendingImageProposals.delete(id);
  return { ok: true, entry, proposal };
}

// ГМ отклонил — возвращает предложение (для уведомления автора) или null.
function rejectImageProposal(id) {
  const proposal = pendingImageProposals.get(id);
  if (!proposal) return null;
  pendingImageProposals.delete(id);
  return proposal;
}

// Смена сцены — предложения привязаны к прежней локации, сбрасываем все.
function clearImageProposals() {
  const all = listImageProposals();
  pendingImageProposals.clear();
  return all;
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
// состав боя. Инициатива — кубик проверок + атрибут инициативы (по умолчанию d20+Тело; настройки игры, check),
// порядок хода строится по убыванию.
function startCombat(participants) {
  if (!Array.isArray(participants)) return state.combat;
  const check = gameConfig.get().check;
  const order = participants
    .map((p) => {
      const entity = p.type === 'npc' ? findNpc(p.id) : findCharacter(p.id);
      if (!entity) return null;
      // NPC с другой локации на открытой карте нет — в бой не берём (клиент их и не присылает).
      if (p.type === 'npc' && entity.locationId !== state.activeLocationId) return null;
      const bonus = (entity.attributes && entity.attributes[check.initiativeAttr]) || 0;
      const die = Math.floor(Math.random() * check.die) + 1;
      return { type: p.type, id: p.id, name: entity.name, die, initiative: die + bonus };
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

// Новый раунд: участники боя снова получают полный запас энергии (иначе сходивший
// в 1-м раунде стоял бы во 2-м с нулём — раньше энергия сбрасывалась только при
// завершении боя). Только энергия и только те, кто в порядке хода: остальные
// персонажи и NPC вне боя не затрагиваются.
function restoreCombatEnergy() {
  state.combat.order.forEach((entry) => {
    const entity = entry.type === 'npc' ? findNpc(entry.id) : findCharacter(entry.id);
    if (entity && entity.energy) entity.energy.current = entity.energy.max;
  });
}

function nextTurn() {
  if (!state.combat.active || !state.combat.order.length) return state.combat;
  state.combat.currentIndex += 1;
  if (state.combat.currentIndex >= state.combat.order.length) {
    state.combat.currentIndex = 0;
    state.combat.round += 1;
    restoreCombatEnergy();
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
// dead — автор сейчас играет убитым персонажем: клиент помечает его ☠.
function addChatMessage(author, text, kind = 'user', dead = false) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().slice(0, config.CHAT_MESSAGE_MAX_LENGTH);
  if (!trimmed) return null;
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    author: author || 'Аноним',
    dead: !!dead,
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

function clearChat() {
  state.chat = [];
  try {
    fs.writeFileSync(CHAT_FILE, JSON.stringify(state.chat));
  } catch (err) {
    console.warn('Не удалось сохранить chat.json:', err.message);
  }
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
    weather: state.weather,
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
  // Пишем во временный файл и переименовываем: остановка процесса (docker stop, перезапуск) посреди записи
  // раньше оставляла обрезанный runtime.json — и вся партия (позиции, HP, бой, картинки) терялась при старте.
  // Переименование поверх файла может не удаться (антивирус держит его на Windows) — тогда пишем напрямую.
  try {
    const json = JSON.stringify(snapshot);
    const tmp = `${RUNTIME_FILE}.tmp`;
    try {
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, RUNTIME_FILE);
    } catch (err) {
      fs.writeFileSync(RUNTIME_FILE, json);
    }
  } catch (err) {
    console.warn('Не удалось сохранить runtime.json:', err.message);
  }
}

// ---- Ролики: показ (библиотека и загрузка файлов — server/videos.js) ---------------------------------------
// state.video = { playId, id, startedAt }. playId уникален для каждого запуска: тот же ролик, запущенный
// повторно, начинается у клиентов заново, а переподключение с прежним playId ничего не перезапускает.
let videoPlaySeq = 0;

function playVideo(id) {
  const entry = typeof id === 'string' ? videos.get(id) : null;
  if (!entry) return { ok: false, reason: 'not-found' };
  videoPlaySeq += 1;
  state.video = { playId: `${Date.now().toString(36)}-${videoPlaySeq}`, id: entry.id, startedAt: Date.now() };
  return { ok: true, duration: entry.duration };
}

function stopVideo() {
  const had = !!state.video;
  state.video = null;
  return had;
}

// Ролик удаляют из библиотеки — если он как раз идёт, показ останавливается.
function removeVideo(id) {
  const wasPlaying = !!(state.video && state.video.id === id);
  if (wasPlaying) state.video = null;
  return { ok: typeof id === 'string' && videos.remove(id), wasPlaying };
}

// Показ для клиентов: elapsed (секунды с начала) считает сервер в момент рассылки — у клиентов часы разные, а
// вошедший посреди ролика или переподключившийся должен начать с нужного места. Доиграл (+ запас) — показ снимается.
function publicVideo() {
  const v = state.video;
  if (!v) return null;
  const entry = videos.get(v.id);
  if (!entry) { state.video = null; return null; }
  const elapsed = (Date.now() - v.startedAt) / 1000;
  if (entry.duration > 0 && elapsed > entry.duration + config.VIDEO_END_GRACE_MS / 1000) { state.video = null; return null; }
  return { playId: v.playId, id: v.id, url: `/assets/video/${entry.file}`, elapsed: Math.round(elapsed * 100) / 100, duration: entry.duration };
}

// Таймер в index.js зовёт это по окончании ролика: true — показ снят, надо разослать state.
function expireVideo() {
  const had = !!state.video;
  publicVideo();
  return had && !state.video;
}

// ---- Скрытое имя NPC: маска для игроков ------------------------------------
// Настоящее имя остаётся в данных (и у ГМ); игрокам вместо него — gameConfig.get().hiddenName.
// Маска накладывается при выдаче, поэтому снятие галочки сразу возвращает имя везде, в том
// числе в старых записях журнала бросков и в порядке хода.
function isNpcNameHidden(id) {
  const n = findNpc(id);
  return !!(n && n.nameHidden);
}

// NPC для игрока: без заметок ГМ, а у скрытого — без имени и роли (поле nameHidden не отдаём).
function publicNpc({ notes, secret, nameHidden, ...rest }) {
  return nameHidden ? { ...rest, name: gameConfig.get().hiddenName, role: '' } : rest;
}

// Порядок хода (state.combat.order или payload combat:started) с замаскированными именами NPC.
function publicCombatOrder(order) {
  if (!Array.isArray(order)) return order;
  return order.map((e) => (e.type === 'npc' && isNpcNameHidden(e.id) ? { ...e, name: gameConfig.get().hiddenName } : e));
}

function publicCombat() {
  return { ...state.combat, order: publicCombatOrder(state.combat.order) };
}

// Журнал бросков: записи скрытого NPC подписаны маской.
function publicDiceLog() {
  return state.diceLog.map((e) => (e.kind === 'npc' && isNpcNameHidden(e.characterId)
    ? { ...e, characterName: gameConfig.get().hiddenName }
    : e));
}

function getPublicState() {
  const activeId = state.activeLocationId;
  return {
    currentDc: state.currentDc,
    // Код доступа — секрет между ГМ и игроком, игрокам (в т.ч. чужим) видны
    // только остальные поля персонажа; notes — заметки ГМ о персонаже, тоже только ГМ.
    characters: characters.map(({ code, notes, ...rest }) => rest),
    diceLog: publicDiceLog(),
    map: getActiveLocationLayout(),
    activeLocationId: activeId,
    // Имя активной локации — игроку нужно для строки «Текущая локация» (списка
    // локаций у него нет, он приходит только в getGMState).
    activeLocationName: (findLocation(activeId) || locations[0]).name,
    // Настройки игры (название, тема, подписи, параметры проверок) — одинаковы для всех, секретов нет.
    game: gameConfig.get(),
    skillsCatalog,
    chat: state.chat,
    combat: publicCombat(),
    // Картинки/рисунки — только активной локации (то же множество, что уже
    // рисуется на канвасе).
    mapImages: state.mapImages.filter((m) => m.locationId === activeId),
    drawings: state.drawings.filter((d) => d.locationId === activeId),
    // Музыка — общее состояние воспроизведения, видно всем (у каждого клиента
    // своя громкость, но трек и позиция синхронны).
    music: state.music,
    // Погода — общая для всех и для всех локаций; личный выключатель у каждого клиента свой.
    weather: state.weather,
    // Идущий ролик (или null): общее окно показа у всех, см. public/js/videofx.js.
    video: publicVideo(),
    // Игрокам видны только NPC активной локации, которых мастер явно сделал
    // видимыми — и то без notes/secret: это заметки только для ГМ (см.
    // NpcInfoDialog.vue, поля «Заметки»/«Секрет»), их не фильтровали по
    // аналогии с characters.code, хотя должны были.
    npcs: npcs
      .filter((n) => n.visible && n.position && n.locationId === activeId)
      .map(publicNpc),
  };
}

function getGMState() {
  return {
    ...getPublicState(),
    // ГМ видит настоящие имена в порядке хода и журнале бросков (публичные версии замаскированы).
    combat: state.combat,
    diceLog: state.diceLog,
    characters,
    // ВСЕ NPC всех локаций (нефильтрованные) — панель «Персонажи» нужна ГМ
    // для подготовки локаций заранее, до переключения на них.
    npcs,
    // Полный список локаций — для панели переключения/управления.
    locations,
    // Библиотека роликов — только ГМ (панель «Ролики»); игрокам нужен лишь идущий ролик (video выше).
    videos: videos.list(),
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
  isCharacterDead,
  setNpcVisible,
  setNpcNameHidden,
  isAvatarPresetUrl,
  listAvatarPresets,
  saveUserPreset,
  removeUserPreset,
  listAudio,
  stopMusicIfTrackGone,
  saveSfx,
  resetSfx,
  saveSkill,
  removeSkill,
  playVideo,
  stopVideo,
  removeVideo,
  expireVideo,
  // каталоги в data/ (volume Docker), которые index.js отдаёт под прежними адресами
  storagePaths: {
    video: videos.VIDEO_DIR,
    avatarUploads: UPLOADS_DIR,
    mapImages: MAP_IMAGES_DIR,
    presets: USER_PRESETS_DIR,
    music: AUDIO_UPLOAD_DIRS.music,
    sounds: AUDIO_UPLOAD_DIRS.sounds,
    sfx: SFX_DIR,
  },
  publicCombatOrder,
  setNpcDead,
  setNpcFaction,
  setNpcLocation,
  addLocation,
  moveLocation,
  renameLocation,
  setActiveLocation,
  getActiveLocationId: () => state.activeLocationId,
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
  planLightningHits,
  applyLightningHits,
  getReachableCells,
  rollDice,
  rollDamage,
  clearDiceLog,
  parseDiceExpression,
  formatFreeRoll,
  setFog,
  getFog,
  setWeather,
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
  reorderMapImage,
  removeMapImage,
  duplicateMapImage,
  updateOwnedMapImage,
  reorderOwnedMapImage,
  removeOwnedMapImage,
  pruneImageProposals,
  proposeMapImage,
  listImageProposals,
  approveImageProposal,
  rejectImageProposal,
  clearImageProposals,
  addDrawing,
  removeDrawing,
  undoLastDrawing,
  clearDrawings,
  addChatMessage,
  clearChat,
  startCombat,
  endCombat,
  nextTurn,
  applyDamage,
  persistRuntimeState,
  getPublicState,
  getGMState,
};
