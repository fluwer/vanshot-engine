const fs = require('fs');
const path = require('path');
const config = require('./config');
const { writeFileAtomic } = require('./fsutil');

// Настройки игры: название, тема, звуки интерфейса, подписи и иконки, параметры проверок.
// Всё, что отличает одну игру от другой при тех же правилах движка. Хранится двумя слоями:
//   server/defaults/game.json — «пример» (запечён в образ, только чтение);
//   server/data/game.json     — правки ГМ (том Docker): только то, что ГМ изменил.
// Действующий конфиг = defaults + правки; уходит клиентам в state.game. Правки приходят от ГМ
// (game:update), каждое поле проверяется, неизвестные ключи отбрасываются — объект целиком
// из сети не принимается никогда.

const DATA_DIR = path.join(__dirname, 'data');
const DEFAULTS_FILE = path.join(__dirname, 'defaults', 'game.json');
const GAME_FILE = path.join(DATA_DIR, 'game.json');

// Идентификаторы — свойство движка (на них завязаны правила и интерфейс), меняются только подписи.
const ATTR_IDS = ['body', 'mind', 'charisma'];
const RESOURCE_IDS = ['hp', 'energy', 'resolve', 'armor'];
const FACTION_IDS = ['enemy', 'ally', 'neutral'];
const SFX_KINDS = ['diceRoll', 'combatStart', 'sceneEnter'];
const THEME_KEYS = ['accent', 'bg', 'text', 'amber'];

const HEX_RE = /^#[0-9a-f]{6}$/i;
const SFX_URL_RE = /^\/assets\/sfx\/[\w.-]{1,100}\.(mp3|ogg|wav)$/i;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

class Invalid extends Error {
  constructor(where) {
    super(`invalid:${where}`);
    this.where = where;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- Проверка отдельных значений: возвращают очищенное значение или бросают Invalid(путь) ----
function text(v, max, where, { allowEmpty = false } = {}) {
  if (typeof v !== 'string') throw new Invalid(where);
  const s = v.trim();
  if ((!s && !allowEmpty) || s.length > max || CONTROL_RE.test(s)) throw new Invalid(where);
  return s;
}

// Иконки интерфейса — реестр public/js/icons-data.js (генерируется из scripts/icons.list). Сервер сверяет
// выбранную ГМ иконку с ним, чтобы в интерфейсе не появлялось «имя иконки» текстом. Файл не нашёлся
// (нестандартная раскладка) — остаётся проверка формата имени.
const ICONS_FILE = path.join(__dirname, '..', 'public', 'js', 'icons-data.js');
let knownIcons = null;
function iconNames() {
  if (knownIcons) return knownIcons;
  try {
    const src = fs.readFileSync(ICONS_FILE, 'utf-8');
    knownIcons = new Set([...src.matchAll(/^\s*"([a-z0-9-]+)":/gm)].map((m) => m[1]));
  } catch (err) {
    console.warn('Не удалось прочитать реестр иконок:', err.message);
    knownIcons = new Set();
  }
  return knownIcons;
}
function isKnownIcon(name) {
  if (typeof name !== 'string' || !config.GAME_ICON_NAME_RE.test(name)) return false;
  const names = iconNames();
  return names.size === 0 || names.has(name);
}

function icon(v, where) {
  if (!isKnownIcon(v)) throw new Invalid(where);
  return v;
}

function hex(v, where) {
  if (typeof v !== 'string' || !HEX_RE.test(v)) throw new Invalid(where);
  return v.toLowerCase();
}

function int(v, min, max, where) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Invalid(where);
  return v;
}

// Объект с фиксированным набором ключей: чужие ключи молча отбрасываем, значения проверяет fn.
function keyed(raw, ids, where, fn) {
  if (!isObj(raw)) throw new Invalid(where);
  const out = {};
  ids.forEach((id) => {
    if (id in raw) out[id] = fn(raw[id], `${where}.${id}`);
  });
  return out;
}

// Поля внутри записи (подпись, иконка…): тоже по белому списку.
function fields(raw, where, spec) {
  if (!isObj(raw)) throw new Invalid(where);
  const out = {};
  Object.keys(spec).forEach((name) => {
    if (name in raw) out[name] = spec[name](raw[name], `${where}.${name}`);
  });
  return out;
}

const SECTIONS = {
  title: (v, w) => text(v, config.GAME_TITLE_MAX_LENGTH, w),
  subtitle: (v, w) => text(v, config.GAME_SUBTITLE_MAX_LENGTH, w, { allowEmpty: true }),
  hiddenName: (v, w) => text(v, config.GAME_HIDDEN_NAME_MAX_LENGTH, w),
  showBundled: (v, w) => { if (typeof v !== 'boolean') throw new Invalid(w); return v; },
  theme: (v, w) => keyed(v, THEME_KEYS, w, (c, p) => (c === null ? null : hex(c, p))),
  sfx: (v, w) => keyed(v, SFX_KINDS, w, (s, p) => {
    if (s === null) return null;
    const o = fields(s, p, {
      url: (u, pp) => { if (typeof u !== 'string' || !SFX_URL_RE.test(u)) throw new Invalid(pp); return u; },
      volume: (n, pp) => { if (typeof n !== 'number' || !(n >= 0 && n <= 1)) throw new Invalid(pp); return Math.round(n * 100) / 100; },
    });
    if (!o.url) throw new Invalid(`${p}.url`);
    if (o.volume === undefined) o.volume = 1;
    return o;
  }),
  attributes: (v, w) => keyed(v, ATTR_IDS, w, (a, p) => fields(a, p, {
    label: (x, pp) => text(x, config.GAME_LABEL_MAX_LENGTH, pp),
    icon,
  })),
  resources: (v, w) => keyed(v, RESOURCE_IDS, w, (r, p) => fields(r, p, {
    label: (x, pp) => text(x, config.GAME_LABEL_MAX_LENGTH, pp),
    short: (x, pp) => text(x, config.GAME_SHORT_LABEL_MAX_LENGTH, pp),
    icon,
  })),
  factions: (v, w) => keyed(v, FACTION_IDS, w, (f, p) => fields(f, p, {
    label: (x, pp) => text(x, config.GAME_LABEL_MAX_LENGTH, pp),
    icon,
    color: hex,
  })),
  check: (v, w) => fields(v, w, {
    die: (x, p) => { if (!config.GAME_DIE_SIDES.includes(x)) throw new Invalid(p); return x; },
    critSuccess: (x, p) => (x === null ? null : int(x, 2, Math.max(...config.GAME_DIE_SIDES), p)),
    critFail: (x, p) => (x === null ? null : int(x, 1, Math.max(...config.GAME_DIE_SIDES) - 1, p)),
    bonus: (x, p) => fields(x, p, {
      cost: (n, pp) => int(n, 0, config.GAME_BONUS_COST_MAX, pp),
      amount: (n, pp) => int(n, 0, config.GAME_BONUS_AMOUNT_MAX, pp),
    }),
    initiativeAttr: (x, p) => { if (!ATTR_IDS.includes(x)) throw new Invalid(p); return x; },
    dcPresets: (x, p) => {
      if (!Array.isArray(x) || !x.length || x.length > config.GAME_DC_PRESETS_MAX) throw new Invalid(p);
      return x.map((item, i) => {
        const o = fields(item, `${p}.${i}`, {
          label: (s, pp) => text(s, config.GAME_DC_PRESET_LABEL_MAX_LENGTH, pp),
          value: (n, pp) => int(n, 1, config.GAME_DC_MAX, pp),
        });
        if (!o.label || o.value === undefined) throw new Invalid(`${p}.${i}`);
        return o;
      });
    },
    damageDice: (x, p) => {
      if (!Array.isArray(x) || !x.length || x.length > config.GAME_DIE_SIDES.length) throw new Invalid(p);
      const sides = x.map((n) => { if (!config.GAME_DIE_SIDES.includes(n)) throw new Invalid(p); return n; });
      return [...new Set(sides)].sort((a, b) => a - b);
    },
  }),
};

// Слияние слоёв: объекты — по ключам, всё остальное (числа, строки, массивы, null) заменяется целиком.
function merge(base, patch) {
  const out = isObj(base) ? { ...base } : {};
  Object.keys(patch).forEach((k) => {
    out[k] = isObj(patch[k]) && isObj(out[k]) ? merge(out[k], patch[k]) : clone(patch[k]);
  });
  return out;
}

// Правка целиком: все поля проверяются, при первой ошибке — Invalid (ничего не применяется).
function cleanPatch(raw) {
  if (!isObj(raw)) throw new Invalid('patch');
  const out = {};
  Object.keys(SECTIONS).forEach((key) => {
    if (key in raw) out[key] = SECTIONS[key](raw[key], key);
  });
  return out;
}

// Связи между полями проверки: пороги критов лежат в пределах кубика и не пересекаются.
function checkConsistency(cfg) {
  const { die, critSuccess, critFail } = cfg.check;
  if (critSuccess !== null && (critSuccess < 2 || critSuccess > die)) throw new Invalid('check.critSuccess');
  if (critFail !== null && (critFail < 1 || critFail >= die)) throw new Invalid('check.critFail');
  if (critSuccess !== null && critFail !== null && critFail >= critSuccess) throw new Invalid('check.critFail');
}

// ---- Загрузка ----
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

const defaults = cleanPatch(readJson(DEFAULTS_FILE)); // пример обязан быть исправным — иначе это ошибка сборки
checkConsistency(defaults);

// Файл ГМ читаем терпимо: битая секция отбрасывается (остаётся значение из примера), сервер стартует всегда.
function loadOverrides() {
  for (const file of [GAME_FILE, `${GAME_FILE}.bak`]) {
    if (!fs.existsSync(file)) continue;
    try {
      const raw = readJson(file);
      if (!isObj(raw)) continue;
      const out = {};
      Object.keys(SECTIONS).forEach((key) => {
        if (!(key in raw)) return;
        try {
          out[key] = SECTIONS[key](raw[key], key);
        } catch (err) {
          console.warn(`game.json: поле «${key}» отброшено (${err.message})`);
        }
      });
      return out;
    } catch (err) {
      console.error(`Не удалось прочитать ${path.basename(file)}:`, err.message);
    }
  }
  return {};
}

let overrides = loadOverrides();
let effective = compute();

function compute() {
  let cfg = merge(defaults, overrides);
  try {
    checkConsistency(cfg);
  } catch (err) {
    console.warn(`game.json: ${err.message}, секция «check» взята из примера`);
    overrides = { ...overrides };
    delete overrides.check;
    cfg = merge(defaults, overrides);
  }
  return cfg;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(GAME_FILE, JSON.stringify(overrides, null, 2));
}

// Действующий конфиг (только чтение: объект общий, его отдают в state каждому клиенту).
function get() {
  return effective;
}

// Правка от ГМ. { ok: true, config } либо { ok: false, reason }; при отказе ничего не меняется.
function update(rawPatch) {
  let next;
  try {
    const patch = cleanPatch(rawPatch);
    next = merge(overrides, patch);
    checkConsistency(merge(defaults, next));
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, reason: err.message };
    throw err;
  }
  const prev = overrides;
  overrides = next;
  try {
    save();
  } catch (err) {
    overrides = prev;
    console.warn('Не удалось сохранить game.json:', err.message);
    return { ok: false, reason: 'save-failed' };
  }
  effective = merge(defaults, overrides);
  return { ok: true, config: effective };
}

// Вернуть раздел (или всё) к примеру.
function reset(section) {
  if (section === 'all') {
    overrides = {};
  } else if (section in SECTIONS) {
    const next = { ...overrides };
    delete next[section];
    overrides = next;
  } else {
    return { ok: false, reason: 'invalid:section' };
  }
  try {
    save();
  } catch (err) {
    console.warn('Не удалось сохранить game.json:', err.message);
  }
  effective = merge(defaults, overrides);
  return { ok: true, config: effective };
}

module.exports = {
  get,
  update,
  reset,
  isKnownIcon,
  ATTR_IDS,
  RESOURCE_IDS,
  FACTION_IDS,
  SFX_KINDS,
  SFX_URL_RE,
};
