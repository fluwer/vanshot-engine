// Заметки ГМа при наведении курсора на героя или NPC: плавающее окошко с их заметками (только у ГМа — скрипт
// подключён лишь в gm.html; игрокам заметки в state не приходят). Читать можно, не открывая окно «Инфо»;
// править по-прежнему только в нём.
//
// Один элемент .note-peek в body (position: fixed, как .tip: его не режут ни скролл блока, ни overflow
// модалок). Текст — только через textContent. Показывают двое: фишки на карте (map.js → gm.js, хук
// setTokenHoverHandler) и карточки в правой колонке (Vue-директива v-note-peek, src/gm-panel/notePeek.js).
//
// window.NotePeek:
//   blocksFor(type, entity) — единственное место, где собирается содержимое: [{ title, sections: [{ label, text }] }].
//     Герой — «Заметки», NPC — «Заметки» и «Секрет»; пустые (после trim) пропускаются, нет ни одного — [].
//   show(blocks, rect, { owner, delay }) — показать рядом с экранным прямоугольником rect {left, top, right, bottom}
//     через delay мс (по умолчанию 300). Вызов с тем же owner, пока окно показано или ожидается, лишь обновляет
//     содержимое и положение (без мигания и без нового ожидания); другой owner — начинает заново.
//   update(blocks, owner) — обновить текст, если окно сейчас принадлежит owner (заметки правят, пока курсор стоит).
//   hide(owner?) — погасить; с owner — только если окно принадлежит ему.
(function () {
  const SHOW_DELAY_MS = 300;
  const GAP = 10;     // зазор между объектом и окошком
  const MARGIN = 8;   // отступ от края окна браузера

  let el = null;
  let timer = null;
  let cur = null;     // { blocks, sig, rect, owner } — окно ожидается или показано
  let visible = false;

  function ensureEl() {
    if (!el) {
      el = document.createElement('div');
      el.className = 'note-peek';
      el.setAttribute('role', 'tooltip');
      document.body.appendChild(el);
    }
    return el;
  }

  function blocksFor(type, entity) {
    if (!entity) return [];
    const sections = [];
    const add = (label, text) => {
      const t = typeof text === 'string' ? text.trim() : '';
      if (t) sections.push({ label, text: t });
    };
    add('Заметки', entity.notes);
    if (type === 'npc') add('Секрет', entity.secret);
    if (!sections.length) return [];
    // Заголовок — как в карточке: у героя имя игрока в скобках, у NPC роль.
    const extra = type === 'npc' ? entity.role : entity.claimedBy;
    return [{ title: extra ? `${entity.name} (${extra})` : String(entity.name || ''), sections }];
  }

  function render() {
    const root = ensureEl();
    root.textContent = '';
    cur.blocks.forEach((b) => {
      const block = document.createElement('div');
      block.className = 'note-peek-block';
      const title = document.createElement('div');
      title.className = 'note-peek-title';
      title.textContent = b.title;
      block.appendChild(title);
      b.sections.forEach((s) => {
        const label = document.createElement('div');
        label.className = 'note-peek-label';
        label.textContent = s.label;
        const text = document.createElement('div');
        text.className = 'note-peek-text';
        text.textContent = s.text;
        block.append(label, text);
      });
      root.appendChild(block);
    });
  }

  // Справа от объекта; не помещается (правая колонка ГМа у края окна) — слева; по верху объекта, зажато в окно.
  function place() {
    const r = cur.rect;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = r.right + GAP;
    if (left + w > window.innerWidth - MARGIN) left = r.left - GAP - w;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN));
    const top = Math.max(MARGIN, Math.min(r.top, window.innerHeight - h - MARGIN));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    // Длинные заметки обрезаются по высоте — снизу затухание (читать целиком — в окне «Инфо»).
    el.classList.toggle('note-peek-clipped', el.scrollHeight > el.clientHeight + 1);
  }

  function reveal() {
    timer = null;
    if (!cur || document.querySelector('.modal-backdrop')) return; // поверх открытого окна не нужно
    render();
    place();
    el.classList.add('note-peek-visible');
    visible = true;
  }

  function hide(owner) {
    if (owner !== undefined && cur && cur.owner !== owner) return;
    clearTimeout(timer);
    timer = null;
    cur = null;
    visible = false;
    if (el) el.classList.remove('note-peek-visible');
  }

  function show(blocks, rect, opts) {
    if (!blocks || !blocks.length || !rect) { hide(); return; }
    const owner = (opts && opts.owner) || null;
    const delay = opts && opts.delay !== undefined ? opts.delay : SHOW_DELAY_MS;
    const sig = JSON.stringify(blocks);
    const same = !!cur && owner !== null && cur.owner === owner && (visible || timer !== null);
    const changed = !same || cur.sig !== sig;
    cur = { blocks, sig, rect, owner };
    if (same) {
      if (visible) {
        if (changed) render();
        place();
      }
      return;
    }
    clearTimeout(timer);
    visible = false;
    if (el) el.classList.remove('note-peek-visible');
    if (delay > 0) timer = setTimeout(reveal, delay);
    else reveal();
  }

  function update(blocks, owner) {
    if (!cur || cur.owner !== owner) return;
    if (!blocks || !blocks.length) { hide(); return; }
    cur.blocks = blocks;
    cur.sig = JSON.stringify(blocks);
    if (visible) { render(); place(); }
  }

  // Любое действие мышью/клавишей, прокрутка того, где лежит объект, смена размера окна, уход курсора со страницы —
  // окно гасим (как .tip). Прокрутку посторонних контейнеров (лента чата) игнорируем: иначе окно мигало бы от чужих событий.
  document.addEventListener('pointerdown', () => hide(), true);
  document.addEventListener('keydown', () => hide(), true);
  document.addEventListener('scroll', (e) => {
    if (!cur) return;
    const t = e.target;
    if (!(cur.owner instanceof Element)) return; // у фишки на карте владельца-элемента нет — карта не прокручивается
    if (t === document || (t instanceof Node && t.contains(cur.owner))) hide();
  }, true);
  window.addEventListener('resize', () => hide());
  document.documentElement.addEventListener('pointerleave', () => hide());
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });

  window.NotePeek = { blocksFor, show, update, hide };
}());
