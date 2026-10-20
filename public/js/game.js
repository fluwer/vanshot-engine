// Настройки игры на клиенте: window.Game. Скрипт стоит в <head> и выполняется до отрисовки страницы —
// тема и название применяются сразу, без мерцания. Источники конфига: window.GAME_BOOT (сервер подставляет
// его в HTML, см. renderPage в server/index.js) и state.game при каждой рассылке (gm.js / player.js зовут
// Game.update). Сам конфиг — server/gameConfig.js; здесь только чтение и применение.
//
//   Game.config        действующий конфиг (объект заменяется целиком, не мутируется)
//   Game.onChange(fn)  подписка fn(config, prev); срабатывает при любом изменении
//   Game.attr(id) / res(id) / faction(id)   подпись и иконка (запасной вариант — сам id)
//   Game.sfx(kind)     { url, volume } — свой звук ГМ или стандартный из образа
//   Game.previewTheme(partial) / clearPreview()   предпросмотр цветов, пока ГМ правит их в настройках
//   События document: 'game:change' (любое изменение) и 'theme:change' (цвета: перечитать canvas).
(function () {
  // Значения tokens.css: от них считается «как в примере» и предпросмотр в настройках.
  const THEME_DEFAULTS = { accent: '#79c6ee', bg: '#0b0e13', text: '#e5ebf3', amber: '#e8b04f' };
  const SFX_DEFAULTS = {
    diceRoll: '/assets/sfx/dice-roll.mp3',
    combatStart: '/assets/sfx/combat-start.mp3',
    sceneEnter: '/assets/sfx/scene-enter.mp3',
  };
  const FACTION_BG_ALPHA = { enemy: 0.16, ally: 0.16, neutral: 0.12 };

  // ---- Цвет ----
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function parseHex(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function toHex(rgb) {
    return `#${rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
  }
  function mix(a, b, t) {
    const A = parseHex(a);
    const B = parseHex(b);
    return toHex(A.map((v, i) => v + (B[i] - v) * t));
  }
  function rgba(h, a) {
    const [r, g, b] = parseHex(h);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  function toHsl(h) {
    const [r, g, b] = parseHex(h).map((v) => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let hue;
    if (max === r) hue = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    return [hue * 60, s, l];
  }
  function fromHsl(hue, s, l) {
    const k = (n) => (n + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
  }
  const luminance = (h) => {
    const [r, g, b] = parseHex(h).map((v) => v / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  // Из одного цвета — семейство токенов (как в tokens.css: поверхности — ступени от фона, текст — к фону).
  // Пока цвет не задан (null) — ничего не ставим, остаётся вид из tokens.css.
  function themeVars(theme, factions) {
    const v = [];
    const t = theme || {};
    const bg = t.bg || THEME_DEFAULTS.bg;
    if (t.bg) {
      v.push(['--bg', t.bg]);
      v.push(['--surface-0', rgba(mix(t.bg, '#ffffff', 0.013), 0.92)]);
      v.push(['--surface-1', rgba(mix(t.bg, '#ffffff', 0.038), 0.97)]);
      v.push(['--surface-pop', rgba(mix(t.bg, '#ffffff', 0.013), 0.97)]);
      v.push(['--surface-2', mix(t.bg, '#ffffff', 0.077)]);
      v.push(['--surface-3', mix(t.bg, '#ffffff', 0.118)]);
      v.push(['--surface-4', mix(t.bg, '#ffffff', 0.166)]);
      v.push(['--field', mix(t.bg, '#ffffff', 0.015)]);
      v.push(['--line', mix(t.bg, '#ffffff', 0.153)]);
      v.push(['--line-strong', mix(t.bg, '#ffffff', 0.243)]);
    }
    if (t.text) {
      v.push(['--text', t.text]);
      v.push(['--text-2', mix(t.text, bg, 0.16)]);
      v.push(['--text-dim', mix(t.text, bg, 0.41)]);
      v.push(['--text-faint', mix(t.text, bg, 0.49)]);
    }
    if (t.accent) {
      const [hue, s, l] = toHsl(t.accent);
      v.push(['--accent', t.accent]);
      v.push(['--accent-strong', fromHsl(hue, s, clamp(l - 0.07, 0, 1))]);
      v.push(['--accent-ink', luminance(t.accent) > 0.4 ? fromHsl(hue, Math.min(s, 0.75), 0.1) : '#f4f8fc']);
      v.push(['--accent-bg', rgba(t.accent, 0.13)]);
      v.push(['--accent-bg-strong', rgba(t.accent, 0.28)]);
      v.push(['--accent-line', rgba(t.accent, 0.55)]);
    }
    if (t.amber) {
      v.push(['--amber', t.amber]);
      v.push(['--amber-bg', rgba(t.amber, 0.14)]);
      v.push(['--amber-line', rgba(t.amber, 0.55)]);
    }
    Object.keys(factions || {}).forEach((id) => {
      const color = factions[id] && factions[id].color;
      if (!color) return;
      v.push([`--${id}`, color]);
      v.push([`--${id}-bg`, rgba(color, FACTION_BG_ALPHA[id] || 0.16)]);
    });
    return v;
  }

  // ---- Состояние ----
  const boot = (typeof window.GAME_BOOT === 'object' && window.GAME_BOOT) || {};
  let config = boot;
  let signature = JSON.stringify(config);
  let preview = null; // { theme } — предпросмотр цветов в настройках (до сохранения)
  const listeners = [];

  const style = document.createElement('style');
  style.id = 'game-theme';
  document.head.appendChild(style);

  // Роль в заголовке вкладки («… — Мастер» / «… — Игрок») сервер подставил в <title> сам; запоминаем её.
  const titleParts = document.title.split(' — ');
  const role = titleParts.length > 1 ? titleParts[titleParts.length - 1] : '';

  function themeSignature(cfg) {
    const colors = {};
    Object.keys(cfg.factions || {}).forEach((id) => { colors[id] = cfg.factions[id].color; });
    return JSON.stringify([cfg.theme, colors]);
  }

  function applyTheme() {
    const theme = preview && preview.theme ? { ...(config.theme || {}), ...preview.theme } : config.theme;
    const vars = themeVars(theme, config.factions);
    style.textContent = vars.length ? `:root{${vars.map(([k, val]) => `${k}:${val}`).join(';')}}` : '';
  }

  function applyTitle() {
    if (config.title) document.title = role ? `${config.title} — ${role}` : config.title;
  }

  function update(next) {
    if (!next || typeof next !== 'object') return;
    const sig = JSON.stringify(next);
    if (sig === signature) return;
    const prev = config;
    const themeChanged = themeSignature(prev) !== themeSignature(next);
    config = next;
    signature = sig;
    applyTheme();
    applyTitle();
    listeners.slice().forEach((fn) => {
      try { fn(config, prev); } catch (err) { console.error('Game.onChange:', err); }
    });
    document.dispatchEvent(new CustomEvent('game:change', { detail: { config, prev } }));
    if (themeChanged) document.dispatchEvent(new CustomEvent('theme:change'));
  }

  function previewTheme(partial) {
    preview = { theme: partial || {} };
    applyTheme();
    document.dispatchEvent(new CustomEvent('theme:change'));
  }

  function clearPreview() {
    if (!preview) return;
    preview = null;
    applyTheme();
    document.dispatchEvent(new CustomEvent('theme:change'));
  }

  const entry = (section, id, fallbackIcon) => {
    const e = (config[section] || {})[id] || {};
    return { id, label: e.label || id, short: e.short || e.label || id, icon: e.icon || fallbackIcon, color: e.color };
  };

  window.Game = {
    THEME_DEFAULTS,
    SFX_DEFAULTS,
    get config() { return config; },
    update,
    onChange(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    attr: (id) => entry('attributes', id, 'diamond'),
    res: (id) => entry('resources', id, 'diamond'),
    faction: (id) => entry('factions', id, 'faction-neutral'),
    sfx(kind) {
      const own = (config.sfx || {})[kind];
      return own && own.url ? { url: own.url, volume: own.volume } : { url: SFX_DEFAULTS[kind], volume: 1 };
    },
    previewTheme,
    clearPreview,
  };

  applyTheme();
  applyTitle();
}());
