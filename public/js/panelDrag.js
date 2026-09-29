// ---- Плавающие окна: перетаскивание за заголовок + сворачивание по клику,
// с сохранением позиции/свёрнутости в localStorage между перезагрузками.
// Общий для gm.js (.draggable-panel) и player.js — у игрока дополнительно
// поддерживается закрытие (closable) и дефолтное открытое/закрытое
// состояние при первом визите (defaultOpen), у мастера эти опции не
// передаются — поведение идентично старой версии (см. CLAUDE.md про
// асимметрию ГМ/игрок).
function loadPanelState(panel, prefix) {
  try { return JSON.parse(localStorage.getItem(`${prefix}:${panel.id}`)); } catch (e) { return null; }
}
function savePanelState(panel, prefix, patch) {
  const state = loadPanelState(panel, prefix) || {};
  Object.assign(state, patch);
  localStorage.setItem(`${prefix}:${panel.id}`, JSON.stringify(state));
}
function showPanel(panel, prefix) {
  panel.classList.remove('panel-closed');
  savePanelState(panel, prefix, { closed: false });
}

function makeDraggable(panel, opts) {
  const { storagePrefix, closable = false, defaultOpen = true } = opts;
  // Сворачивание избыточно там, где окно и так можно закрыть (✕) и свободно
  // изменить в размере (resize:both) — у ГМ окна не закрываются, поэтому
  // сворачивание остаётся единственным способом временно освободить место.
  const collapsible = !closable;
  const handle = panel.querySelector('.overlay-head');
  let startX, startY, originLeft, originTop, moved = false;

  const saved = loadPanelState(panel, storagePrefix);
  if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
    panel.style.left = `${saved.left}px`;
    panel.style.top = `${saved.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }
  if (saved && typeof saved.width === 'number') panel.style.width = `${saved.width}px`;
  // Высоту свёрнутой при сохранении панели проставлять сразу нельзя — иначе
  // она откроется такой же высоты вместо схлопнутого заголовка (см.
  // .overlay.collapsed .overlay-body{display:none} — саму высоту блока это
  // не трогает). Кладём в _savedHeight, откуда её достанет клик-хендлер
  // разворачивания ниже — та же переменная, что и при обычном сворачивании.
  if (saved && typeof saved.height === 'number') {
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
  // сбрасывался на дефолтный из style.css. Свёрнутое состояние игнорируем:
  // там высота — служебный сброс на время анимации, а не то, что выбрал
  // пользователь.
  let resizeSaveTimer = null;
  new ResizeObserver(() => {
    if (panel.classList.contains('collapsed')) return;
    clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(() => {
      const rect = panel.getBoundingClientRect();
      savePanelState(panel, storagePrefix, { width: Math.round(rect.width), height: Math.round(rect.height) });
    }, 300);
  }).observe(panel);

  function onMove(e) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    if (moved) {
      panel.style.left = `${originLeft + dx}px`;
      panel.style.top = `${originTop + dy}px`;
    }
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (moved) {
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
}

window.PanelDrag = { makeDraggable, savePanelState, showPanel };
