const socket = io();
// JoinForm.vue/ActionRailPanel.vue/DrawingPanel.vue/ChatPanel.vue (public/dist/player-panel.js)
// переиспользуют этот же сокет через window.playerBridge, а не создают свой —
// см. src/player-panel/main.js.
window.playerSocket = socket;

// Название игры/подзаголовок — из gameConfig.json, чтобы движок не был
// зашит под конкретную игру (см. TODO).
fetch('/gameConfig.json')
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}))
  .then((cfg) => {
    if (cfg.title) document.title = `${cfg.title} — Игрок`;
    const h1 = document.querySelector('#join-form h1');
    if (cfg.subtitle && h1) h1.textContent = `${cfg.subtitle} — вход`;
  });

// Пока играет анимация «Начать бой», прячем обновление индикатора боя —
// иначе итоговый порядок хода виден раньше, чем долетели кубики. Гейтинг
// (fxHolding/pendingCombatState) живёт в src/player-panel/main.js, рядом
// с остальной проводкой window.combatPanelApp.
initCombatStartFx(socket, {
  onStart: () => window.combatPanelApp?.setFxHolding(true),
  onEnd: () => window.combatPanelApp?.setFxHolding(false),
});

const joinForm = document.getElementById('join-form');
const app = document.getElementById('app');

let myCharacterId = null;
let mapController = null;
// Туман приходит отдельным событием fog:update и может долететь раньше,
// чем создастся mapController (join ещё не завершился) — буферизуем
// последний blob и применяем его сразу после создания mapController.
let lastFogBlob = null;
// Сервер шлёт 'state' сразу при join(), ДО ack'а (см. server/index.js) —
// то есть раньше, чем отработает колбэк join() и создастся mapController.
// Без буферизации этот первый снимок (картинки карты, токены) теряется:
// mapController создастся, но останется пустым до следующего
// broadcastState() от любого действия. Обычно это происходит быстро и
// незаметно, но при авто-рджойне после перезагрузки страницы может не
// происходить вовсе — экран карты остаётся чёрным.
let lastState = null;

// Масштабирует картинку в offscreen-canvas до maxSize по большей стороне
// и отдаёт JPEG data URL — переиспользуется JoinForm.vue через bridge.
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

// --- Вход ----------------------------------------------------------------
// Сохранённая сессия (код+имя+персонаж) в localStorage — как персистентность
// камеры в map.js (ключ vanshot:..., try/catch на случай приватного режима),
// позволяет не проходить форму входа заново после случайной перезагрузки
// страницы. Код доступа не привязан к socket.id на сервере (см.
// gameState.verifyCharacterCode), поэтому авто-рджойн с новым socket.id
// работает без серверных изменений.
const SESSION_KEY = 'vanshot:playerSession';

function saveSession({ characterId, name, code }) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ characterId, name, code }));
  } catch (e) { /* localStorage недоступен — не критично */ }
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved && saved.characterId && saved.code) return saved;
  } catch (e) { /* битые данные — работаем как при первом входе */ }
  return null;
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* недоступен */ }
}

// Единственное место, откуда шлётся 'join' при коннекте — если тут же
// попытается ещё и JoinForm.vue при монтировании, получится гонка двух
// emit'ов на сервере. Есть сохранённая сессия — тихо пробуем войти под
// прошлым персонажем; не вышло (код сменился/персонаж удалён) — сбрасываем
// её и уходим в обычный 'observer' с формой входа.
socket.on('connect', () => {
  if (mapController) mapController.skipNextTokenAnimation(); // после реконнекта позиции — без проигрывания ходьбы
  window.diceFx.skipNext(); // и старые броски из лога — без повторного проигрывания
  const saved = loadSession();
  if (!saved) {
    socket.emit('join', { role: 'observer' });
    return;
  }
  socket.emit('join', { role: 'player', name: saved.name, characterId: saved.characterId, code: saved.code }, (result) => {
    if (result && result.ok) {
      onJoined({ characterId: saved.characterId, name: saved.name });
    } else {
      clearSession();
      socket.emit('join', { role: 'observer' });
    }
  });
});

// Спецэффекты могут прилететь до join (mapController ещё null) — как и
// fog:update, просто игнорируем в этом случае.
socket.on('vfx:play', ({ type, x, y }) => {
  if (mapController) mapController.playEffect(type, x, y);
});

// Вызывается из JoinForm.vue (через window.playerBridge.onJoined) после
// успешного socket 'join' с ролью 'player' — всё, что раньше было внутри
// joinBtn.addEventListener('click', ...) после проверки result.ok.
function onJoined({ characterId, name }) {
  myCharacterId = characterId;
  window.charactersStoreApp?.setMyCharacterId(characterId);

  joinForm.classList.add('hidden');
  app.classList.remove('hidden');
  // Окна измерить можно только теперь (до входа #app скрыт, размеры нулевые): вернуть в
  // экран те, чьи сохранённые/дефолтные позиции его не вмещают.
  window.PanelDrag.clampAll();

  mapController = createMapController({
    canvas: document.getElementById('map-canvas'),
    role: 'player',
    myCharacterId,
  });
  mapController.applyFogBlob(lastFogBlob);
  if (lastState) mapController.updateState(lastState);
  mapController.setMoveHandler((target, x, y) => {
    socket.emit('move', { characterId: target.id, x, y }, (result) => {
      if (!result.ok) console.warn('Ход невозможен:', result.reason);
      requestReachable();
    });
  });
  mapController.setDrawAddHandler((stroke) => socket.emit('drawing:add', stroke));
  mapController.setDrawEraseHandler((id) => socket.emit('drawing:erase', { id }));
  mapController.setDrawUndoHandler(() => socket.emit('drawing:undo')); // ПКМ в режиме рисования
  mapController.setVfxPlaceHandler((type, x, y) => socket.emit('vfx:trigger', { type, x, y }));
  // Правка СВОИХ картинок (после «Принять» ГМ): один апдейт на жест, по отпусканию.
  // Сервер проверяет владение и блокировку; при отказе пришлёт свежий state, и
  // картинка вернётся на место, а мы скажем почему.
  mapController.setMapImageUpdateHandler((patch) => {
    socket.emit('mapimage:update', patch, (res) => {
      if (res && !res.ok && res.reason !== 'rate-limit') {
        window.imageTools.notify(IMAGE_EDIT_REASONS[res.reason] || 'Не удалось изменить картинку', 'error');
      }
    });
  });
  mapController.setMapImageSelectHandler((id) => window.imagesPanelApp?.setSelected(id));
  window.imagesPanelApp?.setMyCharacterId(myCharacterId);
  window.playerBridge.mapController = mapController;
  requestReachable();
  // Первый снимок пришёл до join (см. lastState выше) — кубики: помечаем
  // историю бросков виденной, без проигрывания; сцена: приветствие при входе и
  // после перезагрузки страницы (повторный onJoined при реконнекте с той же
  // локацией ничего не покажет — sceneFx помнит последнюю).
  if (lastState) {
    window.diceFx.onState(lastState);
    window.sceneFx.onState(lastState);
  }
}

// --- Вставка картинки (Ctrl+V) -------------------------------------------
// Игрок не кладёт картинку на карту сам, а ПРЕДЛАГАЕТ её ГМ: она появится
// только после «Принять» (server/gameState.proposeMapImage). Слушатель один на
// страницу; до входа (mapController нет) вставка игнорируется.
const IMAGE_EDIT_REASONS = {
  locked: 'ГМ заблокировал эту картинку',
  forbidden: 'Эту картинку вам менять нельзя',
  'wrong-location': 'Эта картинка относится к другой локации',
};
const PROPOSAL_REASONS = {
  'limit-reached': 'Достигнут лимит ваших картинок на карте — удалите лишнюю в панели «Картинки»',
  'pending-exists': 'Дождитесь решения ГМ по предыдущей картинке',
  cooldown: 'Подождите пару секунд перед следующей картинкой',
  'too-many': 'У ГМ слишком много картинок на согласовании — попробуйте позже',
  'too-large': 'Картинка слишком тяжёлая',
  invalid: 'Не удалось отправить: неподдерживаемый формат картинки',
  forbidden: 'Войдите в игру персонажем, чтобы предлагать картинки',
};
let proposingImage = false;

document.addEventListener('paste', async (e) => {
  if (!mapController || !myCharacterId) return;
  if (window.imageTools.shouldIgnorePaste(e)) return;
  const files = window.imageTools.clipboardImageFiles(e);
  if (!files.length) return;
  e.preventDefault();
  if (proposingImage) return;
  proposingImage = true;
  const unlock = setTimeout(() => { proposingImage = false; }, 10000); // страховка, если ack не придёт
  const file = files[0]; // одно предложение за раз
  try {
    const { dataUrl, w, h } = await window.imageTools.encodeFile(file);
    const center = mapController.getCameraCenter(); // куда игрок смотрел в момент вставки
    // Начальный масштаб: картинка влезает примерно в 40% видимой области, а не
    // ложится в натуральную величину (до 1600 мировых px — это 100 клеток шириной).
    const view = mapController.getViewSize();
    const scale = Math.min(1, (0.4 * view.w) / w, (0.4 * view.h) / h);
    socket.emit(
      'mapimage:propose',
      { dataUrl, naturalWidth: w, naturalHeight: h, name: window.imageTools.imageName(file), x: center.x, y: center.y, scale },
      (res) => {
        clearTimeout(unlock);
        proposingImage = false;
        if (res && res.ok) window.imageTools.notify('Картинка отправлена ГМ на согласование', 'ok');
        else window.imageTools.notify(PROPOSAL_REASONS[res && res.reason] || 'Не удалось отправить картинку', 'error');
      },
    );
  } catch (err) {
    clearTimeout(unlock);
    proposingImage = false;
    window.imageTools.notify((err && err.message) || 'Не удалось прочитать картинку', 'error');
  }
});

// Итог решения ГМ по предложенной картинке.
// Принятая картинка: запоминаем её id — как только она появится в state.mapImages
// (событие приходит раньше state), открываем панель «Картинки» и включаем правку.
let pendingFocusImageId = null;
socket.on('mapimage:proposal:result', ({ status, imageId }) => {
  if (status === 'approved' && imageId) pendingFocusImageId = imageId;
  const texts = {
    approved: ['ГМ принял вашу картинку — её можно двигать и менять размер', 'ok'],
    rejected: ['ГМ отклонил вашу картинку', 'error'],
    cancelled: ['Предложение отменено: ГМ сменил сцену', 'error'],
    expired: ['Предложение устарело: ГМ не ответил', 'error'],
  };
  const t = texts[status];
  if (t) window.imageTools.notify(t[0], t[1]);
});

window.playerBridge = {
  socket,
  resizeImage,
  requestReachable,
  mapController: null,
  onJoined,
  saveSession,
  loadSession,
  clearSession,
};

// Кнопка «Выход из сессии» — сбрасывает сохранённые код/имя/персонажа и
// перезагружает страницу; после этого connect уйдёт в обычный observer-флоу
// с пустой формой входа.
document.getElementById('leave-session-btn')?.addEventListener('click', () => {
  if (!confirm('Выйти из сессии? Понадобится код доступа, чтобы зайти снова.')) return;
  clearSession();
  location.reload();
});

// Пробел телепортирует камеру к своему персонажу — игнорируем, если фокус
// на текстовом поле (например, в чате), чтобы не мешать вводу пробела.
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (!mapController) return;
  e.preventDefault();
  mapController.centerOnMyCharacter();
});

// --- Выдвижные ящики и сворачиваемые оверлеи -----------------------------
document.querySelectorAll('.drawer-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const drawer = document.getElementById(btn.dataset.drawer);
    const wasOpen = drawer.classList.contains('open');
    document.querySelectorAll('.drawer').forEach((d) => d.classList.remove('open'));
    document.querySelectorAll('.drawer-btn').forEach((b) => b.classList.remove('active'));
    if (!wasOpen) {
      drawer.classList.add('open');
      btn.classList.add('active');
    }
  });
});
// Делегирование на document (а не querySelectorAll+forEach в момент
// загрузки): кнопка закрытия sheet-drawer теперь рендерится Vue-компонентом
// (SheetDrawerPanel.vue) позже, чем выполняется этот скрипт, — прямой
// addEventListener на неё в этот момент ничего бы не нашёл.
document.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('.drawer-close');
  if (!closeBtn) return;
  document.getElementById(closeBtn.dataset.close).classList.remove('open');
  document.querySelectorAll('.drawer-btn').forEach((b) => b.classList.remove('active'));
});
// ---- Плавающие панели (Отряд/Лог/Саундборд/Музыка/Бой/Рисование/Эффекты) --
// Драг/resize/сворачивание/закрытие/персистентность — в общем panelDrag.js
// (переиспользуется и gm.js). У игрока, в отличие от ГМ, панели ещё и
// закрываемые (closable) и по умолчанию (только при первом визите, пока
// нет сохранённого состояния) часть панелей скрыта — см. DEFAULT_OPEN_PANELS.
const DEFAULT_OPEN_PANELS = new Set(['party-panel', 'dicelog-panel', 'combat-indicator-panel']);
document.querySelectorAll('#app .draggable-panel').forEach((panel) => {
  PanelDrag.makeDraggable(panel, {
    storagePrefix: 'playerPanel',
    closable: true,
    defaultOpen: DEFAULT_OPEN_PANELS.has(panel.id),
  });
});

// Ящик «Инструменты» — список всех панелей с возможностью открыть/закрыть;
// подпись берём из самой панели, чтобы не дублировать русский текст ещё раз.
// Кнопки НЕ носят класс .drawer-btn (только свой .tools-toggle-btn с тем же
// видом, см. style.css) — иначе общий обработчик ящиков выше при каждом
// клике сбрасывает .active со ВСЕХ .drawer-btn и стирает подсветку.
const toolsList = document.getElementById('tools-drawer-list');
const toolsSyncFns = [];
document.querySelectorAll('#app .draggable-panel').forEach((panel) => {
  const label = panel.querySelector('.overlay-head > span')?.textContent ?? panel.id;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tools-toggle-btn';
  btn.textContent = label;
  const sync = () => btn.classList.toggle('active', !panel.classList.contains('panel-closed'));
  sync();
  toolsSyncFns.push(sync);
  btn.addEventListener('click', () => {
    if (panel.classList.contains('panel-closed')) {
      PanelDrag.showPanel(panel, 'playerPanel');
    } else {
      panel.classList.add('panel-closed');
      PanelDrag.savePanelState(panel, 'playerPanel', { closed: true });
    }
    sync();
  });
  toolsList.appendChild(btn);
});
// Панель могла закрыться и в обход этой кнопки — через свой крестик
// (panelDrag.js). Пересинхронизируем подсветку при каждом открытии/закрытии
// самого ящика «Инструменты», чтобы не полагаться на память конкретной кнопки.
document.querySelector('.drawer-btn[data-drawer="tools-drawer"]')?.addEventListener('click', () => {
  toolsSyncFns.forEach((fn) => fn());
});
// «Сбросить расположение окон»: позиции, размеры, свёрнутость и набор открытых
// окон по умолчанию — без перезагрузки страницы (перезагрузка заново показала бы
// приветствие сцены и перезапустила музыку).
document.getElementById('tools-reset-layout')?.addEventListener('click', () => {
  PanelDrag.resetLayout('playerPanel', { resetOpen: true });
  toolsSyncFns.forEach((fn) => fn());
  window.imageTools.notify('Окна возвращены на места', 'ok');
});

function requestReachable() {
  if (!myCharacterId || !mapController) return;
  socket.emit('reachable', { characterId: myCharacterId }, (cells) => {
    mapController.setReachable(cells);
  });
}

socket.on('fog:update', ({ blob }) => {
  lastFogBlob = blob;
  if (mapController) mapController.applyFogBlob(blob);
});

socket.on('state', (state) => {
  lastState = state;
  window.charactersStoreApp?.updateState(state.characters, state.skillsCatalog);
  window.diceLogPanelApp?.updateState(state.diceLog);
  window.locationBadgeApp?.updateState(state.activeLocationName);
  window.imagesPanelApp?.updateState(state.mapImages);
  renderChat(state.chat);
  window.combatPanelApp?.updateState(state.combat, state.npcs || []);
  applyMusicState(state.music);

  // Кубики и приветствие сцены — только после входа: до join форма входа, и
  // звук/анимации «в пустоту» не нужны (первый снимок обработает onJoined).
  if (mapController) {
    mapController.updateState(state);
    window.diceFx.onState(state);
    window.sceneFx.onState(state);
    requestReachable();
    if (pendingFocusImageId && (state.mapImages || []).some((m) => m.id === pendingFocusImageId)) {
      const id = pendingFocusImageId;
      pendingFocusImageId = null;
      window.imagesPanelApp?.focus(id);
    }
  }
});
