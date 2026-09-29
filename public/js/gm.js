const socket = io();
// Пилотная Vue-панель «Участники» (public/dist/gm-panel.js) переиспользует
// этот же сокет, а не создаёт свой — см. src/gm-panel/main.js.
window.gmSocket = socket;

// Название игры — из gameConfig.json, чтобы движок не был зашит под
// конкретную игру (см. TODO).
fetch('/gameConfig.json')
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}))
  .then((cfg) => {
    if (cfg.title) document.title = `${cfg.title} — Мастер`;
  });

const diceStage = initDiceStage(document.getElementById('dice-stage'));
const diceOverlay = document.getElementById('dice-overlay');
let lastDiceId = null;
let diceHideTimer = null;

// ---- Аватары NPC (те же пресеты, что и у персонажей в player.js) — из
// /avatars/presets/manifest.json, без хардкода списка ----
let npcAvatarPresetUrls = [];
fetch('/avatars/presets/manifest.json')
  .then((r) => (r.ok ? r.json() : []))
  .catch(() => [])
  .then((list) => {
    npcAvatarPresetUrls = (Array.isArray(list) ? list : []).map((p) => p.url);
  });

// Масштабирует картинку в offscreen-canvas до maxSize по большей стороне
// и отдаёт JPEG data URL — как в player.js, но своя копия (нет общего модуля).
function resizeImage(file, maxSize, cb) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
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
  getNpcAvatarPresetUrls: () => npcAvatarPresetUrls,
  resizeImage,
  npcColor: NPC_COLOR,
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

// ---- Спецэффекты (дым/огонь/фейерверк) — доступны и ГМ, и игрокам ----
mapController.setVfxPlaceHandler((type, x, y) => socket.emit('vfx:trigger', { type, x, y }));
socket.on('vfx:play', ({ type, x, y }) => mapController.playEffect(type, x, y));

socket.on('connect', () => {
  socket.emit('join', { role: 'gm', name: 'Мастер' });
});

// Пока играет анимация «Начать бой», прячем обновление панели «Бой» —
// иначе итоговый порядок хода виден раньше, чем долетели кубики. Гейтинг
// (fxHolding/pendingCombatState) теперь живёт в src/gm-panel/main.js, рядом
// с остальной проводкой window.combatPanelApp.
initCombatStartFx(socket, {
  onStart: () => window.combatPanelApp?.setFxHolding(true),
  onEnd: () => window.combatPanelApp?.setFxHolding(false),
});

// ---- Плавающие окна: перетаскивание/сворачивание/персистентность вынесены
// в общий public/js/panelDrag.js (переиспользуется и player.js) ----
document.querySelectorAll('.draggable-panel').forEach((p) =>
  PanelDrag.makeDraggable(p, { storagePrefix: 'gmPanel' }));

function requestReachable() {
  const target = mapController.getSelectedTarget();
  // У NPC нет энергобюджетного перемещения — подсветка достижимости им не нужна.
  if (!target || target.type !== 'character') {
    mapController.setReachable([]);
    return;
  }
  socket.emit('reachable', { characterId: target.id }, (cells) => mapController.setReachable(cells));
}


function showDice(entry) {
  if (diceHideTimer) clearTimeout(diceHideTimer);
  diceOverlay.classList.add('show');
  diceStage.show(entry, () => {
    diceHideTimer = setTimeout(() => diceOverlay.classList.remove('show'), 1600);
  });
}

socket.on('state', (state) => {
  window.dcControlsPanelApp?.updateState(state.currentDc);
  window.charactersPanelApp?.updateState(state.characters, state.npcs, state.skillsCatalog, state.locations);
  window.diceLogPanelApp?.updateState(state.diceLog);
  renderChat(state.chat);
  window.combatPanelApp?.updateState(state.combat, state.characters, state.npcs);
  window.mapToolsPanelApp?.updateState(state.mapImages || [], state.locations || [], state.activeLocationId);
  applyMusicState(state.music);
  mapController.updateState(state);
  requestReachable();

  if (state.diceLog.length && state.diceLog[0].id !== lastDiceId) {
    lastDiceId = state.diceLog[0].id;
    showDice(state.diceLog[0]);
  }
});
