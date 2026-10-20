const socket = io();
// Пилотная Vue-панель «Участники» (public/dist/gm-panel.js) переиспользует
// этот же сокет, а не создаёт свой — см. src/gm-panel/main.js.
window.gmSocket = socket;

// ---- Аватары NPC (те же пресеты, что и у персонажей в player.js) — из
// /avatars/presets/manifest.json, без хардкода списка ----
let npcAvatarPresetUrls = [];
// Список готовых картинок читаем при загрузке и после каждого изменения (экран «Игра» зовёт refreshPresets:
// ГМ загрузил/удалил свою картинку или скрыл примеры) — окна героев и NPC берут актуальный список у моста.
function refreshPresets() {
  return fetch('/avatars/presets/manifest.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])
    .then((list) => {
      npcAvatarPresetUrls = (Array.isArray(list) ? list : []).map((p) => p.url);
    });
}
refreshPresets();

// Аватар из файла: квадрат maxSize×maxSize (обрезка по центру, чуть выше — лица), PNG с
// прозрачностью — общая логика в public/js/imagetools.js (avatarFromFile).
function resizeImage(file, maxSize, cb) {
  window.imageTools.avatarFromFile(file, maxSize).then(cb).catch((err) => {
    window.imageTools.notify((err && err.message) || 'Не удалось прочитать картинку', 'error');
  });
}

const mapController = createMapController({
  canvas: document.getElementById('map-canvas'),
  role: 'gm',
  myCharacterId: null,
});

// Мост для пилотной Vue-панели «Участники» — переиспользует уже
// существующие функции/данные gm.js вместо дублирования (см.
// src/gm-panel/main.js и CharactersPanel.vue).
window.gmBridge = {
  selectTarget: (type, id) => mapController.selectTarget(type, id),
  clearSelection: () => mapController.clearSelection(),
  getNpcAvatarPresetUrls: () => npcAvatarPresetUrls,
  refreshPresets,
  resizeImage,
  npcColor: NPC_COLOR,
  npcFactionStyle: FACTION_STYLE, // { enemy|ally|neutral: { color, icon } } — как на токенах (map.js)
  mapController,
};

mapController.setMoveHandler((target, x, y) => {
  if (target.type === 'npc') {
    socket.emit('npc:move:gm', { npcId: target.id, x, y }, (result) => {
      if (!result.ok) console.warn('Ход невозможен:', result.reason);
    });
  } else {
    socket.emit('move:gm', { characterId: target.id, x, y }, (result) => {
      if (!result.ok) console.warn('Ход невозможен:', result.reason);
    });
  }
});
mapController.setSelectHandler(() => {
  requestReachable();
  window.charactersPanelApp?.setSelected(mapController.getSelectedTarget());
});

// Любое действие в интерфейсе сбрасывает выбранного для броска персонажа/NPC
// (иначе забытый выбор можно случайно сдвинуть тапом по карте). Слушатель в
// capture-фазе — не зависит от @click.stop в Vue-панелях. Исключения — зоны,
// где выбор как раз нужен или меняется самим кликом:
//  - карта (#map-canvas): тап сам решает — выбрать / снять / пойти;
//  - нижняя панель (бросок за выбранного, DC ставят перед броском);
//  - тело карточек участников и строки боя: у них свой toggle по клику, а вот
//    кнопки/поля ВНУТРИ них (HP, урон, ☠ и т.п.) — уже «действие» и сбрасывают.
// Кнопки левой панели (Dock) — тоже «действие»: открытие инструмента сбрасывает выбор.
const KEEP_SELECTION_ZONES = '#map-canvas, .action-bar';
const KEEP_SELECTION_CARDS = '.char-mini, .npc-mini, .combat-turn-row';
const KEEP_SELECTION_CONTROLS = 'button, input, label, select, textarea';
document.addEventListener('pointerdown', (e) => {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  if (target.closest(KEEP_SELECTION_ZONES)) return;
  if (target.closest(KEEP_SELECTION_CARDS) && !target.closest(KEEP_SELECTION_CONTROLS)) return;
  mapController.clearSelection();
}, true);

// ---- Режимы редактирования карты (туман/картинки/рисование), взаимоисключение
// (activeEditMode) и все кнопки/поля управления — теперь в MapToolsPanel.vue.
// Здесь остаются только обработчики, завязанные на canvas-жесты, а не на кнопки:
// mapController принимает у каждого из них только один callback.

// ---- Туман войны ----
socket.on('fog:update', ({ blob }) => mapController.applyFogBlob(blob));
mapController.setFogChangeHandler((blob) => socket.emit('fog:set', { blob }));

// ---- Картинки на карте ----
mapController.setMapImageUpdateHandler(({ id, x, y, scale, rotation }) => {
  const payload = { id };
  if (x !== undefined) payload.x = x;
  if (y !== undefined) payload.y = y;
  if (scale !== undefined) payload.scale = scale;
  if (rotation !== undefined) payload.rotation = rotation;
  socket.emit('mapimage:update', payload);
});

// ---- Рисование на карте ----
mapController.setDrawAddHandler((stroke) => socket.emit('drawing:add', stroke));
mapController.setDrawEraseHandler((id) => socket.emit('drawing:erase', { id }));
mapController.setDrawUndoHandler(() => socket.emit('drawing:undo')); // ПКМ в режиме рисования

// ---- Спецэффекты (дым/огонь/фейерверк) — доступны и ГМ, и игрокам ----
mapController.setVfxPlaceHandler((type, x, y) => socket.emit('vfx:trigger', { type, x, y }));
socket.on('vfx:play', ({ type, x, y }) => mapController.playEffect(type, x, y));

socket.on('connect', () => {
  mapController.skipNextTokenAnimation(); // после реконнекта позиции — без проигрывания ходьбы
  window.diceFx.skipNext(); // и старые броски из лога — без повторного проигрывания
  window.journal.skipNext(); // и старые чат-сообщения — без «непрочитанных» и всплывашек
  socket.emit('join', { role: 'gm', name: 'Мастер' });
});

// ---- Предложения картинок от игроков (Ctrl+V с согласованием ГМ) ----
// Карточка с «Принять/Отклонить» — Vue-компонент ImageProposals.vue; сюда
// приходят только события, раздаём их в window.imageProposalsApp.
socket.on('mapimage:proposed', (p) => window.imageProposalsApp?.add(p));
socket.on('mapimage:pending:sync', (list) => window.imageProposalsApp?.sync(list));
socket.on('mapimage:proposal:closed', ({ id }) => window.imageProposalsApp?.remove(id));

// Пока играет анимация «Начать бой», прячем обновление панели «Бой» —
// иначе итоговый порядок хода виден раньше, чем долетели кубики. Гейтинг
// (fxHolding/pendingCombatState) теперь живёт в src/gm-panel/main.js, рядом
// с остальной проводкой window.combatPanelApp.
initCombatStartFx(socket, {
  onStart: () => window.combatPanelApp?.setFxHolding(true),
  onEnd: () => window.combatPanelApp?.setFxHolding(false),
});

// ---- Левая панель инструментов (public/js/dock.js): открыт максимум один блок.
// Туман/рисунок/картинки/локации — разные пункты одного блока карты; пункты-
// инструменты (fog/draw/images/vfx) включают режим карты, пока блок открыт —
// это делают сами Vue-панели по событию dock:change (src/gm-panel/useDock.js).
// «Участники» — отдельная правая колонка, открыта вместе с любым блоком. ----
Dock.init({
  items: [
    { id: 'fog', icon: 'cloud-fog', label: 'Туман', title: 'Туман войны', block: 'maptools-panel', group: 0 },
    { id: 'draw', icon: 'pencil', label: 'Рисунок', title: 'Рисование', block: 'maptools-panel', group: 0 },
    { id: 'images', icon: 'image', label: 'Картинки', title: 'Картинки на карте', block: 'maptools-panel', group: 0 },
    { id: 'vfx', icon: 'sparkles', label: 'Эффекты', title: 'Спецэффекты', block: 'effects-panel', group: 0 },
    { id: 'ruler', icon: 'ruler', label: 'Линейка', title: 'Линейка', block: 'ruler-panel', group: 0 },
    { id: 'locations', icon: 'map', label: 'Локации', title: 'Локации', block: 'maptools-panel', group: 1 },
    { id: 'combat', icon: 'swords', label: 'Бой', title: 'Бой', block: 'combat-panel', group: 1 },
    { id: 'sound', icon: 'volume-2', label: 'Звук', title: 'Звук', block: 'sound-panel', group: 1 },
    { id: 'game', icon: 'sliders-horizontal', label: 'Игра', title: 'Настройки игры', block: 'game-panel', group: 1 },
  ],
  side: { id: 'characters-panel', title: 'Участники' },
});

function requestReachable() {
  const target = mapController.getSelectedTarget();
  // У NPC нет энергобюджетного перемещения — подсветка достижимости им не нужна.
  if (!target || target.type !== 'character') {
    mapController.setReachable([]);
    return;
  }
  socket.emit('reachable', { characterId: target.id }, (cells) => mapController.setReachable(cells));
}

socket.on('state', (state) => {
  window.Game.update(state.game); // настройки игры (название, тема, подписи) — раньше всех, остальное их читает
  window.dcControlsPanelApp?.updateState(state.currentDc);
  window.locationBadgeApp?.updateState(state.activeLocationName);
  window.charactersPanelApp?.updateState(state.characters, state.npcs, state.skillsCatalog, state.locations);
  window.diceLogPanelApp?.updateState(state.diceLog);
  renderChat(state.chat);
  window.combatPanelApp?.updateState(state.combat, state.characters, state.npcs);
  window.mapToolsPanelApp?.updateState(state.mapImages || [], state.locations || [], state.activeLocationId);
  applyMusicState(state.music);
  mapController.updateState(state);
  requestReachable();
  window.journal.onState(state);  // журнал: непрочитанные и всплывашки чата (public/js/journal.js)
  window.diceFx.onState(state);   // кубики: все новые броски, параллельно (public/js/diceFx.js)
  window.sceneFx.onState(state);  // приветствие сцены: при загрузке и при смене локации (public/js/scenefx.js)
  window.weather.onState(state);  // погода на экране: холод/ветер/метель (public/js/weather.js)
});
