// Dock: левая панель инструментов + ОДИН блок за раз (вместо перетаскиваемых окон).
// Общий для gm.js и player.js. Принцип: ничего не открыто, пока не нужно.
//
// Слоты интерфейса (каждый независим):
//  1. Левый блок (.dock-block) — открывается кнопкой из левой панели (.dock-rail);
//     открыт максимум один; повторный клик / ✕ / Esc закрывают.
//  2. Правая колонка ГМ (.dock-side, «Участники») — сворачивается отдельно,
//     открыта вместе с левым блоком (initSide).
//  3. Журнал (чат + броски) — свой модуль public/js/journal.js.
//
// «Пункт» (item) — кнопка панели. Несколько пунктов могут вести в один блок
// (у ГМ туман/рисунок/картинки/локации → один #maptools-panel), тогда блок
// остаётся открытым, а меняется только текущий пункт. Текущий пункт — единственный
// источник правды для режима карты: Vue-панели подписаны на `dock:change`
// (src/gm-panel/useDock.js) и включают/выключают режим по открытию/закрытию.
//
// Блоки ВСЕГДА остаются в DOM (скрыты CSS): soundboard.js/music.js/chat.js
// ищут элементы по фиксированным id один раз при init, пересоздавать нельзя.
(function () {
  const items = [];
  const byId = {};
  const listeners = [];
  let current = null; // id текущего пункта | null
  let rail = null;
  let sideEl = null;
  let sideToggle = null;

  const SIDE_KEY = 'dock:side';

  function safeStorage(fn) {
    try { return fn(); } catch (err) { return null; }
  }

  // Старая механика плавающих окон хранила позиции в localStorage — чистим один раз.
  function cleanLegacyStorage() {
    safeStorage(() => {
      const stale = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('gmPanel:') || k.startsWith('playerPanel:'))) stale.push(k);
      }
      stale.forEach((k) => localStorage.removeItem(k));
    });
  }

  function emit(prev) {
    const detail = { item: current, prev };
    document.dispatchEvent(new CustomEvent('dock:change', { detail }));
    listeners.forEach((fn) => { try { fn(detail); } catch (err) { console.error(err); } });
  }

  function blockOf(item) {
    return item && item.block ? document.getElementById(item.block) : null;
  }

  function render() {
    const item = current ? byId[current] : null;
    const openBlockId = item ? item.block : null;
    document.querySelectorAll('.dock-block').forEach((block) => {
      const isOpen = block.id === openBlockId;
      block.classList.toggle('dock-open', isOpen);
      if (isOpen) {
        const title = block.querySelector('.dock-title');
        if (title) title.textContent = item.title || item.label;
      }
    });
    if (rail) {
      rail.querySelectorAll('.dock-btn[data-item]').forEach((btn) => {
        const on = btn.dataset.item === current;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
  }

  function open(id) {
    const item = byId[id];
    if (!item || item.action || current === id) return;
    const prev = current;
    current = id;
    render();
    emit(prev);
  }

  function close() {
    if (current === null) return;
    const prev = current;
    current = null;
    render();
    emit(prev);
  }

  function toggle(id) {
    if (current === id) close();
    else open(id);
  }

  // Шапка блока: заголовок текущего пункта + ✕. Вставляется первым ребёнком.
  function ensureHead(block) {
    if (block.querySelector(':scope > .dock-head')) return;
    const head = document.createElement('div');
    head.className = 'dock-head';
    const title = document.createElement('span');
    title.className = 'dock-title';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'dock-close';
    closeBtn.title = 'Закрыть (Esc)';
    closeBtn.setAttribute('aria-label', 'Закрыть');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', close);
    head.append(title, closeBtn);
    block.insertBefore(head, block.firstChild);
  }

  function makeButton(item) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dock-btn';
    btn.title = item.title || item.label;
    btn.setAttribute('aria-label', item.title || item.label);
    if (item.action) {
      btn.addEventListener('click', item.action);
    } else {
      btn.dataset.item = item.id;
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => toggle(item.id));
    }
    const ico = document.createElement('span');
    ico.className = 'dock-ico';
    ico.textContent = item.icon;
    const lbl = document.createElement('span');
    lbl.className = 'dock-lbl';
    lbl.textContent = item.label;
    btn.append(ico, lbl);
    return btn;
  }

  function buildRail(stage) {
    rail = document.createElement('nav');
    rail.className = 'dock-rail';
    rail.setAttribute('aria-label', 'Инструменты');
    const main = document.createElement('div');
    main.className = 'dock-rail-card';
    const bottom = document.createElement('div');
    bottom.className = 'dock-rail-card';
    let lastGroup = null;
    items.forEach((item) => {
      if (item.bottom) {
        bottom.appendChild(makeButton(item));
        return;
      }
      if (lastGroup !== null && item.group !== lastGroup) {
        const sep = document.createElement('div');
        sep.className = 'dock-sep';
        main.appendChild(sep);
      }
      lastGroup = item.group;
      main.appendChild(makeButton(item));
    });
    rail.appendChild(main);
    // Нижняя карточка (например «Выход») — только если в ней что-то есть.
    if (bottom.childElementCount) rail.appendChild(bottom);
    stage.appendChild(rail);
  }

  // Вкладки блока с несколькими корнями: .dock-tabs > [data-tab] + .dock-pane[data-pane].
  // Возвращает { select(name), current() }; onChange(name) вызывается после смены.
  function initTabs(root, onChange) {
    const tabs = Array.from(root.querySelectorAll('.dock-tabs [data-tab]'));
    const panes = Array.from(root.querySelectorAll('.dock-pane[data-pane]'));
    const startTab = tabs.find((t) => t.classList.contains('active')) || tabs[0];
    let currentTab = startTab ? startTab.dataset.tab : null;
    function select(name) {
      currentTab = name;
      tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
      panes.forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
      if (onChange) onChange(name);
    }
    tabs.forEach((t) => t.addEventListener('click', () => select(t.dataset.tab)));
    return { select, current: () => currentTab };
  }

  // Правая колонка ГМ («Участники»): сворачивается в кнопку у края, состояние помним.
  function initSide(stage, opts) {
    sideEl = document.getElementById(opts.id);
    if (!sideEl) return;
    sideEl.classList.add('dock-side');
    const head = document.createElement('div');
    head.className = 'dock-head';
    const title = document.createElement('span');
    title.className = 'dock-title';
    title.textContent = opts.title || 'Участники';
    const collapse = document.createElement('button');
    collapse.type = 'button';
    collapse.className = 'dock-close';
    collapse.title = 'Свернуть колонку';
    collapse.setAttribute('aria-label', 'Свернуть колонку');
    collapse.textContent = '›';
    head.append(title, collapse);
    sideEl.insertBefore(head, sideEl.firstChild);

    sideToggle = document.createElement('button');
    sideToggle.type = 'button';
    sideToggle.className = 'dock-side-toggle';
    sideToggle.id = 'dock-side-toggle';
    sideToggle.title = `${opts.title || 'Участники'} — развернуть`;
    sideToggle.setAttribute('aria-label', `${opts.title || 'Участники'} — развернуть`);
    sideToggle.textContent = '👥';
    stage.appendChild(sideToggle);

    function setSide(open) {
      stage.classList.toggle('side-open', open);
      safeStorage(() => localStorage.setItem(SIDE_KEY, open ? '1' : '0'));
    }
    collapse.addEventListener('click', () => setSide(false));
    sideToggle.addEventListener('click', () => setSide(true));
    const saved = safeStorage(() => localStorage.getItem(SIDE_KEY));
    stage.classList.toggle('side-open', saved !== '0'); // по умолчанию открыта
  }

  function isTextField(el) {
    if (!el) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    if (el.tagName !== 'INPUT') return false;
    return !['range', 'checkbox', 'radio', 'button', 'file', 'submit'].includes(el.type);
  }

  function onKeydown(e) {
    if (e.key !== 'Escape' || e.defaultPrevented || current === null) return;
    if (document.querySelector('.modal-backdrop')) return;            // Esc закрывает модалку
    if (document.querySelector('.scene-intro-overlay.show')) return;  // и приветствие сцены
    if (isTextField(document.activeElement)) return;                  // Esc в поле ввода — не наш
    if (e.target instanceof Element && e.target.closest('#journal-panel')) return; // журнал закрывает себя сам
    close();
  }

  // opts: { items:[{ id, icon, label, title?, block?, group?, action?, bottom? }],
  //         side?:{ id, title? }, stage? }
  function init(opts) {
    const stage = opts.stage || document.querySelector('.map-stage');
    if (!stage) return;
    cleanLegacyStorage();
    (opts.items || []).forEach((it) => {
      items.push(it);
      byId[it.id] = it;
    });
    const blockIds = new Set();
    items.forEach((it) => { if (it.block) blockIds.add(it.block); });
    blockIds.forEach((id) => {
      const block = document.getElementById(id);
      if (!block) return;
      block.classList.add('dock-block');
      ensureHead(block);
      if (block.querySelector('.dock-tabs')) initTabs(block);
    });
    buildRail(stage);
    if (opts.side) initSide(stage, opts.side);
    document.addEventListener('keydown', onKeydown);
    render();
  }

  window.Dock = {
    init,
    open,
    close,
    toggle,
    get: () => current,
    on: (fn) => { listeners.push(fn); },
    initTabs,
    blockOf,
  };
}());
