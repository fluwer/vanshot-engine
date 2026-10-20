// Иконки интерфейса вместо эмодзи. Данные — public/js/icons-data.js (генерируется
// scripts/build-icons.js из Lucide + собственных иконок), здесь только рантайм.
//
//  Icons.svg(name, { size, cls })  → строка <svg class="ico">…</svg> ('' для неизвестного имени)
//  Icons.el(name, opts)            → DOM-элемент (null для неизвестного имени)
//  Icons.inner(name)               → внутренняя разметка (для Vue-компонента Icon.vue)
//  Icons.has(name)
//  Icons.hydrate(root)             → подменяет <i data-icon="имя"> в статическом HTML
//  Icons.image(name, { color, size }) → кэшируемый Image для canvas (null, пока не загрузился)
//
// Цвет — currentColor: иконка берёт цвет текста кнопки и меняется вместе с её состояниями
// (hover/active). Эмодзи так не умели. Не добавляйте новые эмодзи в интерфейс — добавьте иконку
// в scripts/icons.list и выполните npm run icons.
(function () {
  const DATA = window.ICON_DATA || {};
  const ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

  const has = (name) => Object.prototype.hasOwnProperty.call(DATA, name);
  const inner = (name) => (has(name) ? DATA[name] : '');

  function svg(name, opts) {
    if (!has(name)) return '';
    const o = opts || {};
    const cls = o.cls ? `ico ${o.cls}` : 'ico';
    const size = o.size ? ` width="${o.size}" height="${o.size}"` : '';
    return `<svg class="${cls}"${size} ${ATTRS}>${DATA[name]}</svg>`;
  }

  function el(name, opts) {
    const html = svg(name, opts);
    if (!html) return null;
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    return tpl.content.firstElementChild;
  }

  // Иконка + текст в один узел: <span class="ico-label"><svg/> Текст</span> — для JS, который
  // строит кнопки сам. Текст кладётся через textContent, поэтому безопасен.
  function labelEl(name, text, opts) {
    const wrap = document.createElement('span');
    wrap.className = 'ico-label';
    const icon = el(name, opts);
    if (icon) wrap.appendChild(icon);
    if (text) wrap.appendChild(document.createTextNode(text));
    return wrap;
  }

  function hydrate(root) {
    (root || document).querySelectorAll('[data-icon]').forEach((node) => {
      const icon = el(node.dataset.icon, { size: node.dataset.iconSize, cls: node.dataset.iconCls });
      if (icon) node.replaceWith(icon);
    });
  }

  // Для canvas: SVG → Image через data URL, цвет подставляем вместо currentColor.
  // Как и getAvatarImage в map.js: пока картинка грузится — null, по onload зовём колбэк.
  const imageCache = new Map();
  function image(name, opts, onLoad) {
    if (!has(name)) return null;
    const o = opts || {};
    const color = o.color || '#ffffff';
    const size = o.size || 24;
    const key = `${name}|${color}|${size}`;
    let entry = imageCache.get(key);
    if (!entry) {
      const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ${ATTRS.replace('currentColor', color)}>${DATA[name].replace(/currentColor/g, color)}</svg>`;
      const img = new Image();
      entry = { img, ready: false };
      imageCache.set(key, entry);
      img.onload = () => { entry.ready = true; if (onLoad) onLoad(); };
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    }
    return entry.ready ? entry.img : null;
  }

  // Единый справочник вместо четырёх копий NPC_FACTIONS и трёх копий ATTRIBUTE_ICONS.
  // Подписи и иконки задаёт игра (public/js/game.js → server/data/game.json), идентификаторы — движок.
  // Цвет фракции — CSS-переменная (tokens.css / тема игры), форма значка своя у каждой фракции, чтобы
  // различие читалось и без опоры на цвет. Объекты пересобираются НА МЕСТЕ при смене настроек игры
  // (читатели держат ссылки на window.FACTIONS и т. п.); реактивные потребители (Vue) берут данные
  // из useGame().
  const FACTION_IDS = ['enemy', 'ally', 'neutral'];
  const ATTR_IDS = ['body', 'mind', 'charisma'];
  window.FACTIONS = {};
  window.FACTION_LIST = [];
  window.ATTR_ICONS = {};
  window.ATTR_LABELS = {};
  function syncRegistries() {
    const G = window.Game;
    window.FACTION_LIST.length = 0;
    FACTION_IDS.forEach((id) => {
      const f = G ? G.faction(id) : { label: id, icon: 'faction-neutral' };
      window.FACTIONS[id] = { id, label: f.label, icon: f.icon, cssVar: `--${id}` };
      window.FACTION_LIST.push(window.FACTIONS[id]);
    });
    ATTR_IDS.forEach((id) => {
      const a = G ? G.attr(id) : { label: id, icon: 'diamond' };
      window.ATTR_ICONS[id] = a.icon;
      window.ATTR_LABELS[id] = a.label;
    });
  }
  syncRegistries();
  if (window.Game) window.Game.onChange(syncRegistries);

  window.Icons = { has, svg, el, labelEl, inner, hydrate, image, names: () => Object.keys(DATA) };

  // Скрипт подключается в конце <body>: статические <i data-icon> выше уже разобраны.
  hydrate(document);
}());
