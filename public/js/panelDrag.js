// ---- Плавающие окна: перетаскивание за заголовок + сворачивание по клику,
// с сохранением позиции/свёрнутости в localStorage между перезагрузками.
// Общий для gm.js (.draggable-panel) и player.js — у игрока дополнительно
// поддерживается закрытие (closable) и дефолтное открытое/закрытое
// состояние при первом визите (defaultOpen), у мастера эти опции не
// передаются — поведение идентично старой версии (см. CLAUDE.md про
// асимметрию ГМ/игрок).
//
// Окно не может оказаться за экраном: позиция зажимается в границы .map-stage
// (clampPanelIntoViewport) при перетаскивании, восстановлении из localStorage,
// открытии, ресайзе окна и изменении размера самой сцены (сужение окна браузера,
// поворот телефона, показ #app после входа). Временный clamp от узкого экрана
// в localStorage НЕ пишется — туда попадают только действия пользователя.
// «Сбросить расположение окон» — resetLayout (без перезагрузки страницы).
const PANEL_EDGE = 4;             // минимальный отступ окна от края экрана
const PANEL_BOTTOM_RESERVE = 56;  // снизу — нижняя панель/кнопки: шапка окна не должна оказаться под ними

// Реестр окон — для clampAll() и resetLayout().
const panelRegistry = [];
const observedStages = new WeakSet();

function loadPanelState(panel, prefix) {
  try { return JSON.parse(localStorage.getItem(`${prefix}:${panel.id}`)); } catch (e) { return null; }
}
function savePanelState(panel, prefix, patch) {
  const state = loadPanelState(panel, prefix) || {};
  Object.assign(state, patch);
  // Приватный режим/переполненное хранилище не должны ронять перетаскивание окон.
  try { localStorage.setItem(`${prefix}:${panel.id}`, JSON.stringify(state)); } catch (e) { /* не сохранилось — не критично */ }
}

// Допустимый диапазон левого верхнего угла окна внутри сцены или null, если
// окно/сцену сейчас не измерить (скрыты, закрыты, нулевой размер — например
// #app.hidden у игрока до входа).
function panelBounds(panel) {
  const stage = panel.parentElement;
  if (!stage || panel.classList.contains('panel-closed')) return null;
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const rect = panel.getBoundingClientRect();
  if (!W || !H || !rect.width || !rect.height) return null;
  const handle = panel.querySelector('.overlay-head');
  const headH = handle ? handle.offsetHeight : 28;
  return {
    minLeft: PANEL_EDGE,
    maxLeft: Math.max(PANEL_EDGE, W - rect.width - PANEL_EDGE),
    minTop: PANEL_EDGE,
    // Окно целиком в экране, но шапка не под нижней панелью (важно для свёрнутых окон ГМ).
    maxTop: Math.max(PANEL_EDGE, Math.min(H - rect.height - PANEL_EDGE, H - headH - PANEL_BOTTOM_RESERVE)),
    stageRect: stage.getBoundingClientRect(),
    rect,
  };
}

const clampValue = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Возвращает окно внутрь экрана; true, если пришлось сдвинуть. Ширину/высоту
// ограничивает CSS (.draggable-panel max-width/max-height относительно сцены).
function clampPanelIntoViewport(panel) {
  const b = panelBounds(panel);
  if (!b) return false;
  const left = b.rect.left - b.stageRect.left;
  const top = b.rect.top - b.stageRect.top;
  const nl = clampValue(left, b.minLeft, b.maxLeft);
  const nt = clampValue(top, b.minTop, b.maxTop);
  if (Math.abs(nl - left) < 0.5 && Math.abs(nt - top) < 0.5) return false;
  // Окна с CSS-якорем right/bottom переводим на left/top, иначе inline left/top не сработают.
  panel.style.left = `${nl}px`;
  panel.style.top = `${nt}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  return true;
}

function clampAll() {
  panelRegistry.forEach((p) => clampPanelIntoViewport(p.panel));
}

function showPanel(panel, prefix) {
  panel.classList.remove('panel-closed');
  savePanelState(panel, prefix, { closed: false });
  clampPanelIntoViewport(panel);
}

// Возвращает окна выбранного префикса ('gmPanel' | 'playerPanel') на места по
// умолчанию без перезагрузки страницы (перезагрузка заново показала бы приветствие
// сцены и перезапустила музыку): стирает сохранённые позиции/размеры/свёрнутость,
// снимает inline-стили, а при resetOpen возвращает набор открытых окон по умолчанию.
function resetLayout(prefix, opts = {}) {
  panelRegistry.filter((p) => p.prefix === prefix).forEach((p) => {
    const { panel } = p;
    try { localStorage.removeItem(`${prefix}:${panel.id}`); } catch (e) { /* ничего */ }
    ['left', 'top', 'right', 'bottom', 'width', 'height'].forEach((prop) => panel.style.removeProperty(prop));
    delete panel._savedHeight;
    panel.classList.remove('collapsed');
    if (opts.resetOpen && p.closable) panel.classList.toggle('panel-closed', !p.defaultOpen);
  });
  clampAll();
}

function makeDraggable(panel, opts) {
  const { storagePrefix, closable = false, defaultOpen = true } = opts;
  // Сворачивание избыточно там, где окно и так можно закрыть (✕) и свободно
  // изменить в размере (resize:both) — у ГМ окна не закрываются, поэтому
  // сворачивание остаётся единственным способом временно освободить место.
  const collapsible = !closable;
  const handle = panel.querySelector('.overlay-head');
  let startX, startY, originLeft, originTop, moved = false;

  panelRegistry.push({ panel, prefix: storagePrefix, closable, defaultOpen });

  const saved = loadPanelState(panel, storagePrefix);
  if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
    panel.style.left = `${saved.left}px`;
    panel.style.top = `${saved.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }
  // Нулевой/мусорный размер (старые версии писали 0×0 при закрытии окна) не применяем.
  if (saved && typeof saved.width === 'number' && saved.width > 0) panel.style.width = `${saved.width}px`;
  // Высоту свёрнутой при сохранении панели проставлять сразу нельзя — иначе
  // она откроется такой же высоты вместо схлопнутого заголовка (см.
  // .overlay.collapsed .overlay-body{display:none} — саму высоту блока это
  // не трогает). Кладём в _savedHeight, откуда её достанет клик-хендлер
  // разворачивания ниже — та же переменная, что и при обычном сворачивании.
  if (saved && typeof saved.height === 'number' && saved.height > 0) {
    if (collapsible && saved.collapsed) panel._savedHeight = `${saved.height}px`;
    else panel.style.height = `${saved.height}px`;
  }
  if (collapsible && saved && saved.collapsed) panel.classList.add('collapsed');

  // Открыта/закрыта: явно сохранённое состояние важнее дефолта — дефолт
  // (defaultOpen) действует только при самом первом визите, когда для
  // этой панели ещё ничего не лежит в localStorage.
  const startClosed = saved ? !!saved.closed : !defaultOpen;
  if (startClosed) panel.classList.add('panel-closed');

  if (closable) {
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'panel-close-btn';
    closeBtn.title = 'Закрыть';
    closeBtn.textContent = '✕';
    const controls = handle.querySelector('.overlay-head-controls') || handle;
    controls.appendChild(closeBtn);
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.add('panel-closed');
      savePanelState(panel, storagePrefix, { closed: true });
    });
  }

  // Ручной resize (за правый нижний угол, resize:both в CSS) — запоминаем
  // итоговые width/height, иначе после перезагрузки страницы размер всегда
  // сбрасывался на дефолтный из style.css. Сохраняем ТОЛЬКО размер, который
  // пользователь изменил сам (сравниваем на mouseup с размером на mousedown):
  // ResizeObserver срабатывает и от сужения браузера, рендера содержимого и
  // закрытия окна (0×0) — писать это в storage нельзя (окно открылось бы
  // минимальным или «застряло» уменьшенным).
  let sizeAtMouseDown = null;
  panel.addEventListener('mousedown', () => {
    if (panel.classList.contains('collapsed')) return;
    const r = panel.getBoundingClientRect();
    sizeAtMouseDown = { w: Math.round(r.width), h: Math.round(r.height) };
  });
  document.addEventListener('mouseup', () => {
    if (!sizeAtMouseDown) return;
    const before = sizeAtMouseDown;
    sizeAtMouseDown = null;
    if (panel.classList.contains('collapsed') || panel.classList.contains('panel-closed')) return;
    const r = panel.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (Math.round(r.width) !== before.w || Math.round(r.height) !== before.h) {
      clampPanelIntoViewport(panel);
      savePanelState(panel, storagePrefix, { width: Math.round(r.width), height: Math.round(r.height) });
    }
  });
  // Размер окна меняется и без участия пользователя (содержимое отрисовалось,
  // сузился экран) — тогда его только возвращаем в границы, ничего не сохраняя.
  // Пока пользователь тянет угол окна (sizeAtMouseDown), не двигаем его из-под курсора —
  // вернём в границы на mouseup.
  new ResizeObserver(() => { if (!sizeAtMouseDown) clampPanelIntoViewport(panel); }).observe(panel);

  // Сама сцена меняет размер: сужение окна браузера, поворот телефона, DevTools,
  // показ #app у игрока после входа (0 → ненулевой размер). Один наблюдатель на сцену.
  const stage = panel.parentElement;
  if (stage && !observedStages.has(stage)) {
    observedStages.add(stage);
    new ResizeObserver(() => clampAll()).observe(stage);
  }

  function onMove(e) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    if (moved) {
      // Окно нельзя утащить за границы экрана — зажимаем прямо во время перетаскивания.
      const b = panelBounds(panel);
      const left = b ? clampValue(originLeft + dx, b.minLeft, b.maxLeft) : originLeft + dx;
      const top = b ? clampValue(originTop + dy, b.minTop, b.maxTop) : originTop + dy;
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    }
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (moved) {
      clampPanelIntoViewport(panel);
      const rect = panel.getBoundingClientRect();
      savePanelState(panel, storagePrefix, { left: rect.left, top: rect.top });
    }
  }

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.panel-close-btn')) return;
    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    originLeft = rect.left;
    originTop = rect.top;
    startX = e.clientX;
    startY = e.clientY;
    moved = false;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  handle.addEventListener('click', (e) => {
    if (e.target.closest('.panel-close-btn')) return;
    if (moved) { moved = false; return; }
    if (!collapsible) return;
    // resize:both задаёт панели inline height — при сворачивании его надо
    // убрать (иначе окно остаётся большим), при разворачивании — вернуть.
    if (!panel.classList.contains('collapsed')) {
      panel._savedHeight = panel.style.height;
      panel.style.height = '';
    } else {
      panel.style.height = panel._savedHeight || '';
    }
    panel.classList.toggle('collapsed');
    savePanelState(panel, storagePrefix, { collapsed: panel.classList.contains('collapsed') });
  });

  // Сразу вернуть окно в экран, если сохранённая/дефолтная позиция его не вмещает
  // (если сцену пока не измерить — это сделает наблюдатель за сценой).
  clampPanelIntoViewport(panel);
}

// Страховка, не зависящая от ResizeObserver (он не доставляет уведомления, пока
// вкладка скрыта/не отрисовывается): после загрузки страницы (Vue уже наполнил окна),
// при изменении размера окна браузера и когда вкладка снова становится видимой.
window.addEventListener('load', clampAll);
window.addEventListener('resize', clampAll);
document.addEventListener('visibilitychange', () => { if (!document.hidden) clampAll(); });

window.PanelDrag = { makeDraggable, savePanelState, showPanel, resetLayout, clampAll };
