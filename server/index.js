const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const gameState = require('./gameState');
const gameConfig = require('./gameConfig');
const videos = require('./videos');
const config = require('./config');

const app = express();
const server = http.createServer(app);
// maxHttpBufferSize поднят под загрузку музыкальных треков через dataURL
// (base64 + JSON-обвязка над MUSIC_UPLOAD_MAX_SIZE из config.js) — дефолт
// Socket.IO (~1 МБ) слишком мал даже для существующих mp3-треков (5-13 МБ).
const io = new Server(server, { maxHttpBufferSize: 30 * 1024 * 1024 });

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Динамические списки (маршруты стоят ДО static, иначе отдался бы сам файл-манифест из образа):
// готовые картинки героев/NPC — по содержимому папок presets (положил файл — он появился в выборе;
// подписи и порядок — из необязательных manifest.json), музыка и звуки — поставляемые + добавленные ГМ.
const noCache = (res) => res.set('Cache-Control', 'no-cache');
app.get('/avatars/presets/manifest.json', (req, res) => { noCache(res); res.json(gameState.listAvatarPresets()); });
app.get('/assets/music/manifest.json', (req, res) => { noCache(res); res.json(gameState.listAudio('music')); });
app.get('/assets/sounds/manifest.json', (req, res) => { noCache(res); res.json(gameState.listAudio('sounds')); });

// Страницы ГМ и игрока отдаём с подставленными настройками игры: window.GAME_BOOT (название, тема,
// подписи — клиент применяет их до отрисовки, без мерцания и гонки с загрузкой конфига) и <title>.
// Дальше изменения приходят в state.game. Метка <!--GAME_BOOT--> стоит в <head> HTML.
const PAGE_ROLES = { 'gm.html': 'Мастер', 'player.html': 'Игрок' };
const pageCache = new Map();
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function renderPage(name) {
  const file = path.join(PUBLIC_DIR, name);
  const { mtimeMs } = fs.statSync(file);
  let cached = pageCache.get(name);
  if (!cached || cached.mtimeMs !== mtimeMs) {
    cached = { mtimeMs, html: fs.readFileSync(file, 'utf-8') };
    pageCache.set(name, cached);
  }
  const game = gameConfig.get();
  // JSON внутри <script>: «<» экранируем (иначе «</script>» в названии оборвёт скрипт), U+2028/2029 ломают JS-строки.
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const boot = JSON.stringify(game).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');
  return cached.html
    .replace('<!--GAME_BOOT-->', () => `<script>window.GAME_BOOT=${boot};</script>`)
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${escapeHtml(`${game.title} — ${PAGE_ROLES[name]}`)}</title>`);
}
Object.keys(PAGE_ROLES).forEach((name) => {
  app.get(`/${name}`, (req, res, next) => {
    try {
      noCache(res);
      res.type('html').send(renderPage(name));
    } catch (err) {
      next(); // нет файла — пусть ответит static (404)
    }
  });
});

// Всё, что пишет программа или подкладывает ГМ, лежит в data/ — это единственный каталог, вынесенный на
// диск хоста в Docker (public/ и server/ запечены в образ и пересоздаются при сборке). Отдаём эти папки
// под прежними адресами ПЕРЕД public: файл из data главнее одноимённого из образа (свою картинку можно
// положить поверх поставляемой), а чего в data нет, найдётся в public. Нет папки — просто 404 дальше по цепочке.
const store = gameState.storagePaths;
app.use('/avatars/presets', express.static(store.presets));
app.use('/avatars/uploads', express.static(store.avatarUploads));
app.use('/avatars/map-images', express.static(store.mapImages));
app.use('/assets/music', express.static(store.music));
app.use('/assets/sounds', express.static(store.sounds));
app.use('/assets/sfx', express.static(store.sfx)); // свои звуки интерфейса (экран «Игра»); стандартные — из public/assets/sfx
app.use('/assets/login', express.static(store.login)); // картинка окна входа игрока (экран «Игра → Оформление»)
// Ролики (панель «Ролики»): static понимает Range — клиент начинает с нужной секунды, не качая файл целиком.
// dotfiles: 'ignore' обязателен: по умолчанию прячется только файл с точкой в ПОСЛЕДНЕМ сегменте пути, а
// недокачанные загрузки лежат в .tmp/<id> (точка в каталоге) — без опции они отдавались бы наружу.
app.use('/assets/video', express.static(store.video, { dotfiles: 'ignore' }));
app.use(express.static(PUBLIC_DIR));

// Текст подсказки для команды чата /help.
const CHAT_HELP_TEXT = [
  'Доступные команды:',
  '/roll N — бросок кубика dN, например /roll 10',
  '/roll NdM+K — несколько кубиков с модификатором, например /roll 2d6+3',
  '/me действие — эмоут от своего имени',
  '/help — показать эту подсказку',
].join('\n');

function broadcastState() {
  gameState.persistRuntimeState();
  io.to('players').emit('state', gameState.getPublicState());
  io.to('gm').emit('state', gameState.getGMState());
}

// Ролик доиграл — снимаем показ и рассылаем state (окна у всех и так закрываются по своему «ended»; это для
// ГМ-панели и для тех, кто зайдёт позже). Таймер пересоздаётся при каждом запуске и гасится остановкой.
let videoExpiryTimer = null;
function clearVideoExpiry() {
  if (videoExpiryTimer) clearTimeout(videoExpiryTimer);
  videoExpiryTimer = null;
}
function scheduleVideoExpiry(durationSec) {
  clearVideoExpiry();
  if (!(durationSec > 0)) return;
  videoExpiryTimer = setTimeout(() => {
    videoExpiryTimer = null;
    if (gameState.expireVideo()) broadcastState();
  }, durationSec * 1000 + config.VIDEO_END_GRACE_MS + 300);
  videoExpiryTimer.unref();
}

// Предложения картинок от игроков (Ctrl+V с согласованием ГМ, см. gameState.js).
// Картинка в base64 — только в этих событиях, не в state (иначе раздула бы каждый broadcast).
function proposalToWire(p) {
  return { id: p.id, dataUrl: p.dataUrl, name: p.name, authorName: p.authorName, x: p.x, y: p.y };
}

// Событие всем сокетам игрока-автора (у него может быть открыто несколько вкладок).
function emitToCharacter(characterId, event, payload) {
  io.sockets.sockets.forEach((s) => {
    if (s.data.role === 'player' && s.data.characterId === characterId) s.emit(event, payload);
  });
}

// Предложение закрыто (принято / отклонено / отменено сменой сцены / просрочено):
// ГМ убирает карточку, автору приходит итог.
// extra — доп. поля для автора (при 'approved' это imageId принятой картинки: клиент
// игрока по нему сразу открывает панель «Картинки» и выделяет её).
function closeImageProposal(proposal, status, extra = {}) {
  io.to('gm').emit('mapimage:proposal:closed', { id: proposal.id });
  emitToCharacter(proposal.characterId, 'mapimage:proposal:result', { id: proposal.id, status, ...extra });
}

io.on('connection', (socket) => {
  // Любая ошибка внутри обработчика события (например, деструктуризация `({ a, b }) => …`
  // от пустого payload — null/ничего) иначе не перехватывается Socket.IO и роняет весь процесс:
  // игра встаёт у всех. Оборачиваем socket.on один раз — вместо правки каждого обработчика:
  // ошибка пишется в лог, сервер живёт, а ждущий ack-колбэк получает отказ.
  const rawOn = socket.on.bind(socket);
  socket.on = (event, handler) => rawOn(event, (...args) => {
    const fail = (err) => {
      console.error(`[socket:${event}]`, err && err.message ? err.message : err);
      const ack = args[args.length - 1];
      if (typeof ack === 'function') {
        try { ack({ ok: false, reason: 'server-error' }); } catch (e) { /* ack не обязателен */ }
      }
    };
    try {
      const result = handler(...args);
      if (result && typeof result.catch === 'function') result.catch(fail); // async-обработчики
    } catch (err) {
      fail(err);
    }
  });

  socket.on('join', (payload, ack) => {
    const { role, characterId, code } = payload || {};
    // Имя не доверяем клиенту (в форме есть maxlength, но событие можно послать и без неё): строка, без
    // управляющих символов, не длиннее PLAYER_NAME_MAX_LENGTH. Вошедший игрок без имени — «Игрок».
    let name = gameState.cleanPlayerName((payload || {}).name);
    if (!name && role === 'player') name = 'Игрок';
    // Код доступа защищает от входа под чужим персонажем — проверяем
    // до того, как что-либо менять в состоянии.
    if (role === 'player' && characterId) {
      if (!gameState.verifyCharacterCode(characterId, code)) {
        if (typeof ack === 'function') ack({ ok: false, reason: 'Неверный код доступа' });
        return;
      }
    }

    socket.data.role = role;
    socket.data.name = name;
    socket.data.characterId = characterId || null;   // нужно для authorId в drawing:*
    socket.join(role === 'gm' ? 'gm' : 'players');

    if (role === 'player' && characterId) {
      gameState.claimCharacter(characterId, name, socket.id);
    }

    socket.emit('state', role === 'gm' ? gameState.getGMState() : gameState.getPublicState());
    socket.emit('fog:update', { blob: gameState.getFog() });
    // ГМ мог перезагрузить страницу — возвращаем ему ожидающие предложения картинок.
    if (role === 'gm') {
      gameState.pruneImageProposals().forEach((p) => closeImageProposal(p, 'expired'));
      socket.emit('mapimage:pending:sync', gameState.listImageProposals().map(proposalToWire));
    }
    broadcastState();
    if (typeof ack === 'function') ack({ ok: true });
  });

  // ГМ может перегенерировать код доступа персонажа в любой момент.
  socket.on('character:code:regenerate', ({ characterId }) => {
    if (socket.data.role !== 'gm') return;
    gameState.regenerateCharacterCode(characterId);
    broadcastState();
  });

  // Туман войны рисует только мастер; сервер рассылает blob всем (игрокам и ГМ).
  socket.on('fog:set', ({ blob }) => {
    if (socket.data.role !== 'gm') return;
    gameState.setFog(blob);
    io.emit('fog:update', { blob });
  });

  socket.on('roll', ({ characterId, attribute, spendResolve, label }) => {
    gameState.rollDice(characterId, attribute, spendResolve, label);
    broadcastState();
  });

  // Кубик урона dN: ГМ бросает за любого персонажа/NPC (нет цели — от «Мастера»), игрок —
  // только за своего (присланный characterId игнорируем), наблюдатель — нет. HP не меняется.
  socket.on('roll:damage', (payload) => {
    const { characterId, sides } = payload || {}; // null/мусор от клиента не должен ронять сервер
    let rollerId;
    if (socket.data.role === 'gm') rollerId = typeof characterId === 'string' ? characterId : null;
    else if (socket.data.role === 'player' && socket.data.characterId) rollerId = socket.data.characterId;
    else return;
    if (gameState.rollDamage(rollerId, sides, 'Мастер')) broadcastState(); // sides — строго число из check.damageDice (настройки игры)
  });

  socket.on('dicelog:clear', () => {
    if (socket.data.role !== 'gm') return;
    gameState.clearDiceLog();
    broadcastState();
  });

  // HP/Энергия/Решимость меняет только мастер — у игрока ручного управления нет.
  socket.on('hp:update', ({ characterId, delta }) => {
    if (socket.data.role !== 'gm') return;
    gameState.adjustCharacterHp(characterId, delta);
    broadcastState();
  });

  socket.on('resolve:update', ({ characterId, delta }) => {
    if (socket.data.role !== 'gm') return;
    gameState.adjustResolve(characterId, delta);
    broadcastState();
  });

  socket.on('energy:update', ({ characterId, delta }) => {
    if (socket.data.role !== 'gm') return;
    gameState.adjustEnergy(characterId, delta);
    broadcastState();
  });

  socket.on('armor:update', ({ characterId, delta }) => {
    if (socket.data.role !== 'gm') return;
    gameState.adjustArmor(characterId, delta);
    broadcastState();
  });

  socket.on('character:dead:set', ({ characterId, dead }) => {
    if (socket.data.role !== 'gm') return;
    gameState.setCharacterDead(characterId, dead);
    broadcastState();
  });

  // Готовая картинка герою (или presetUrl: null — убрать, останется буква) — только ГМ, из окна
  // героя. Разрешены только файлы из public/avatars/presets (защита от произвольных URL).
  socket.on('avatar:set', ({ characterId, presetUrl }) => {
    if (socket.data.role !== 'gm') return;
    if (presetUrl !== null && !gameState.isAvatarPresetUrl(presetUrl)) return;
    gameState.setCharacterAvatar(characterId, presetUrl);
    broadcastState();
  });

  // Загруженная картинка: ГМ — любому герою, игрок — только своему (при входе), наблюдатель — нет.
  socket.on('avatar:upload', ({ characterId, dataUrl }, ack) => {
    const allowed = socket.data.role === 'gm'
      || (socket.data.role === 'player' && !!socket.data.characterId && socket.data.characterId === characterId);
    if (!allowed) {
      if (typeof ack === 'function') ack({ ok: false, reason: 'forbidden' });
      return;
    }
    const url = gameState.saveUploadedAvatar(characterId, dataUrl);
    if (typeof ack === 'function') ack({ ok: !!url, url });
    if (url) broadcastState();
  });

  socket.on('dc:set', ({ dc }) => {
    if (socket.data.role !== 'gm') return;
    gameState.setDc(dc);
    broadcastState();
  });

  // Картинки на карте — накладывает, двигает, масштабирует и удаляет только мастер.
  socket.on('mapimage:upload', ({ dataUrl, naturalWidth, naturalHeight, name, x, y }, ack) => {
    if (socket.data.role !== 'gm') {
      if (typeof ack === 'function') ack({ ok: false });
      return;
    }
    const entry = gameState.addMapImage(dataUrl, naturalWidth, naturalHeight, name, x, y);
    if (typeof ack === 'function') ack({ ok: !!entry, entry });
    if (entry) broadcastState();
  });

  // Двигает/масштабирует/вращает картинку ГМ — любую; игрок — только СВОЮ (ownerId,
  // после «Принять» ГМ), не заблокированную ГМ, на активной локации; locked игрок
  // менять не может. Отказ игроку: ack { ok:false, reason } + свежий state (иначе
  // клиент остался бы с оптимистично сдвинутой картинкой).
  socket.on('mapimage:update', (payload, ack) => {
    const reply = (res) => { if (typeof ack === 'function') ack(res); };
    const { id, x, y, scale, rotation, locked, flipX, flipY, stretchX, stretchY, crop } = payload || {};
    // Поле, которого нет в payload, не должно «сбрасываться»: updateMapImage/applyImageGeometry смотрят `key in patch`,
    // поэтому в patch попадают только присланные клиентом поля.
    const geometry = {};
    if (payload && 'stretchX' in payload) geometry.stretchX = stretchX;
    if (payload && 'stretchY' in payload) geometry.stretchY = stretchY;
    if (payload && 'crop' in payload) geometry.crop = crop;
    if (socket.data.role === 'gm') {
      gameState.updateMapImage(id, { x, y, scale, rotation, locked, flipX, flipY, ...geometry });
      reply({ ok: true });
      return broadcastState();
    }
    if (socket.data.role === 'player' && socket.data.characterId) {
      const now = Date.now();
      if (now - (socket.data.lastImageUpdateAt || 0) < config.IMAGE_UPDATE_MIN_INTERVAL_MS) {
        socket.emit('state', gameState.getPublicState());
        return reply({ ok: false, reason: 'rate-limit' });
      }
      socket.data.lastImageUpdateAt = now;
      const result = gameState.updateOwnedMapImage(id, socket.data.characterId, { x, y, scale, rotation, flipX, flipY, ...geometry });
      if (!result.ok) {
        socket.emit('state', gameState.getPublicState());
        return reply({ ok: false, reason: result.reason });
      }
      reply({ ok: true });
      return broadcastState();
    }
    return reply({ ok: false, reason: 'forbidden' });
  });

  // Порядок слоёв картинки: { id, op: 'front' | 'up' | 'down' | 'back' }. ГМ — любой
  // картинки; игрок — только своей (те же условия и троттлинг, что у mapimage:update).
  socket.on('mapimage:reorder', (payload, ack) => {
    const reply = (res) => { if (typeof ack === 'function') ack(res); };
    const { id, op } = payload || {};
    if (socket.data.role === 'gm') {
      const changed = gameState.reorderMapImage(id, op);
      reply({ ok: true, changed });
      return changed ? broadcastState() : undefined;
    }
    if (socket.data.role === 'player' && socket.data.characterId) {
      const now = Date.now();
      if (now - (socket.data.lastImageUpdateAt || 0) < config.IMAGE_UPDATE_MIN_INTERVAL_MS) {
        return reply({ ok: false, reason: 'rate-limit' });
      }
      socket.data.lastImageUpdateAt = now;
      const result = gameState.reorderOwnedMapImage(id, socket.data.characterId, op);
      if (!result.ok) {
        socket.emit('state', gameState.getPublicState());
        return reply({ ok: false, reason: result.reason });
      }
      reply({ ok: true });
      return broadcastState();
    }
    return reply({ ok: false, reason: 'forbidden' });
  });

  // Дубликат картинки: { id } → ack { ok, entry } (клиент выделяет копию). ГМ — любой картинки (копия без владельца);
  // игрок — только своей (владение/блокировка/локация/лимит как у правки, тот же троттлинг), копия тоже его.
  socket.on('mapimage:duplicate', (payload, ack) => {
    const reply = (res) => { if (typeof ack === 'function') ack(res); };
    const { id } = payload || {};
    if (socket.data.role === 'gm') {
      const result = gameState.duplicateMapImage(id, { gm: true });
      if (!result.ok) return reply({ ok: false, reason: result.reason });
      reply({ ok: true, entry: result.entry });
      return broadcastState();
    }
    if (socket.data.role === 'player' && socket.data.characterId) {
      const now = Date.now();
      if (now - (socket.data.lastImageUpdateAt || 0) < config.IMAGE_UPDATE_MIN_INTERVAL_MS) {
        return reply({ ok: false, reason: 'rate-limit' });
      }
      socket.data.lastImageUpdateAt = now;
      const result = gameState.duplicateMapImage(id, { characterId: socket.data.characterId });
      if (!result.ok) return reply({ ok: false, reason: result.reason });
      reply({ ok: true, entry: result.entry });
      return broadcastState();
    }
    return reply({ ok: false, reason: 'forbidden' });
  });

  socket.on('mapimage:remove', (payload, ack) => {
    const reply = (res) => { if (typeof ack === 'function') ack(res); };
    const { id } = payload || {};
    if (socket.data.role === 'gm') {
      gameState.removeMapImage(id);
      reply({ ok: true });
      return broadcastState();
    }
    if (socket.data.role === 'player' && socket.data.characterId) {
      const result = gameState.removeOwnedMapImage(id, socket.data.characterId);
      if (!result.ok) {
        socket.emit('state', gameState.getPublicState());
        return reply({ ok: false, reason: result.reason });
      }
      reply({ ok: true });
      return broadcastState();
    }
    return reply({ ok: false, reason: 'forbidden' });
  });

  // Игрок вставил картинку (Ctrl+V) — она не попадает на карту, пока ГМ не
  // примет. Только вошедший игрок с персонажем (наблюдатель предлагать не может).
  // Если ГМ сейчас не подключён, предложение ждёт в очереди (до IMAGE_PROPOSAL_TTL_MS).
  socket.on('mapimage:propose', (payload, ack) => {
    const reply = (res) => { if (typeof ack === 'function') ack(res); };
    if (socket.data.role !== 'player' || !socket.data.characterId) return reply({ ok: false, reason: 'forbidden' });
    gameState.pruneImageProposals().forEach((p) => closeImageProposal(p, 'expired'));
    const result = gameState.proposeMapImage(socket.data.characterId, socket.data.name, payload);
    if (!result.ok) return reply({ ok: false, reason: result.reason });
    io.to('gm').emit('mapimage:proposed', proposalToWire(result.proposal));
    return reply({ ok: true, id: result.proposal.id });
  });

  // Vue-карточка ГМ запрашивает очередь при монтировании: события proposed/sync
  // могли прийти раньше, чем загрузился бандл, а повторно сервер их не шлёт.
  socket.on('mapimage:pending', (_payload, ack) => {
    if (socket.data.role !== 'gm' || typeof ack !== 'function') return;
    gameState.pruneImageProposals().forEach((p) => closeImageProposal(p, 'expired'));
    ack(gameState.listImageProposals().map(proposalToWire));
  });

  socket.on('mapimage:approve', ({ id }, ack) => {
    const reply = (res) => { if (typeof ack === 'function') ack(res); };
    if (socket.data.role !== 'gm') return reply({ ok: false });
    const result = gameState.approveImageProposal(id);
    if (!result.ok) return reply({ ok: false, reason: result.reason });
    closeImageProposal(result.proposal, 'approved', { imageId: result.entry.id });
    reply({ ok: true, entry: result.entry });
    return broadcastState();
  });

  socket.on('mapimage:reject', ({ id }) => {
    if (socket.data.role !== 'gm') return;
    const proposal = gameState.rejectImageProposal(id);
    if (proposal) closeImageProposal(proposal, 'rejected');
  });

  // Рисование на карте — доступно и ГМ, и игрокам. Цвет определяется сервером
  // по authorId (см. gameState.addDrawing) — клиент цвет не присылает.
  // Наблюдатель (ещё не выбрал персонажа) рисовать не может.
  function drawAuthor() {
    if (socket.data.role === 'gm') return { authorId: 'gm', authorRole: 'gm' };
    if (socket.data.role === 'player' && socket.data.characterId) {
      return { authorId: socket.data.characterId, authorRole: 'player' };
    }
    return null;
  }

  socket.on('drawing:add', ({ points, width }) => {
    const author = drawAuthor();
    if (!author) return;
    const entry = gameState.addDrawing(author.authorId, author.authorRole, points, width);
    if (entry) broadcastState();
  });

  // Ластик стирает только свои же штрихи (включая ГМ) — полный сброс см. drawing:clear.
  socket.on('drawing:erase', ({ id }) => {
    const author = drawAuthor();
    if (!author || typeof id !== 'string') return;
    if (gameState.removeDrawing(id, author.authorId)) broadcastState();
  });

  // Отмена — только последнего штриха ЭТОГО автора, не глобально последнего.
  socket.on('drawing:undo', () => {
    const author = drawAuthor();
    if (!author) return;
    if (gameState.undoLastDrawing(author.authorId)) broadcastState();
  });

  // Полный сброс всех рисунков — только мастер.
  socket.on('drawing:clear', () => {
    if (socket.data.role !== 'gm') return;
    gameState.clearDrawings();
    broadcastState();
  });

  // Спецэффекты на карте (дым/огонь/фейерверк) — доступны и ГМ, и игрокам
  // (см. CLAUDE.md/TODO). Transient-событие, как combat:started: просто
  // ретранслируем всем клиентам, никакого следа в gameState/runtime.json —
  // при реконнекте эффект не повторится, и это нормально.
  socket.on('vfx:trigger', ({ type, x, y }) => {
    if (!config.VFX_TYPES.includes(type)) return;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    // Пасхалка: молния, попавшая в клетку с фишкой игрока, бьёт по ней и отбрасывает на клетку (план — gameState).
    // Двигают фишки только вошедшие ГМ и игроки: наблюдатель молнию ставит, но никого не отбрасывает.
    const hits = type === 'lightning' && drawAuthor() ? gameState.planLightningHits(x, y) : [];
    if (!hits.length) {
      io.emit('vfx:play', { type, x, y });
      return;
    }
    // Разряд бьёт ровно в центр клетки с фишкой; клиенты сами показывают вспышку и отлёт по hits,
    // а положение сервер меняет чуть позже — после вспышки.
    const cell = hits[0].from;
    io.emit('vfx:play', {
      type,
      x: (cell.x + 0.5) * config.CELL_SIZE,
      y: (cell.y + 0.5) * config.CELL_SIZE + 20,
      hits,
    });
    setTimeout(() => {
      if (gameState.applyLightningHits(hits)) broadcastState();
    }, config.LIGHTNING_HIT_DELAY_MS);
  });

  // Погода на экране — одна на всю игру, задаёт только мастер: { mode, intensity }.
  // Рисует клиент (public/js/weather.js); значения проверяет setWeather.
  socket.on('weather:set', (payload) => {
    if (socket.data.role !== 'gm') return;
    if (gameState.setWeather(payload)) broadcastState();
  });

  // Настройки игры (экран «Игра» у ГМ): название, тема, подписи, параметры проверок. Правка — частичный
  // объект; gameConfig.update проверяет каждое поле и при любой ошибке не меняет ничего (ответ — ack).
  // «Показывать примеры из образа» меняет списки музыки, звуков и готовых аватаров: клиенты перечитывают
  // манифесты, а трек, которого в списке больше нет, перестаёт играть.
  function afterGameConfigChange(showBundledBefore) {
    if (gameConfig.get().showBundled !== showBundledBefore) {
      gameState.stopMusicIfTrackGone();
      io.emit('sound:manifest-updated');
      io.emit('music:manifest-updated');
    }
    broadcastState();
  }

  socket.on('game:update', (patch, ack) => {
    if (socket.data.role !== 'gm') return;
    const before = gameConfig.get().showBundled;
    const result = gameConfig.update(patch);
    if (result.ok) afterGameConfigChange(before);
    if (typeof ack === 'function') ack(result.ok ? { ok: true } : { ok: false, reason: result.reason });
  });

  // Вернуть раздел настроек (или 'all') к примеру игры.
  socket.on('game:reset', (payload, ack) => {
    if (socket.data.role !== 'gm') return;
    const section = payload && typeof payload.section === 'string' ? payload.section : '';
    const before = gameConfig.get().showBundled;
    const prevLogin = gameConfig.get().loginImage;
    const result = gameConfig.reset(section);
    // Сброс картинки окна входа (раздел или 'all') — старый файл больше не нужен.
    if (result.ok && prevLogin && !gameConfig.get().loginImage) gameState.removeLoginImageFile(prevLogin.url);
    if (result.ok) afterGameConfigChange(before);
    if (typeof ack === 'function') ack(result.ok ? { ok: true } : { ok: false, reason: result.reason });
  });

  // Звуки интерфейса (кубик, начало боя, заставка локации): { kind, dataUrl } / { kind }. Только мастер.
  socket.on('sfx:upload', (payload, ack) => {
    if (socket.data.role !== 'gm') return;
    const { kind, dataUrl } = payload || {};
    const result = gameState.saveSfx(kind, dataUrl);
    if (result.ok) broadcastState();
    if (typeof ack === 'function') ack(result.ok ? { ok: true, url: result.url } : { ok: false, reason: result.reason });
  });

  socket.on('sfx:reset', (payload, ack) => {
    if (socket.data.role !== 'gm') return;
    const result = gameState.resetSfx((payload || {}).kind);
    if (result.ok) broadcastState();
    if (typeof ack === 'function') ack(result.ok ? { ok: true } : { ok: false, reason: result.reason });
  });

  // Картинка окна входа игрока (data/uploads/login): { dataUrl } / без данных. Только мастер; открытые окна
  // входа обновляются сами — настройка уходит всем в state.game.
  socket.on('loginimg:upload', (payload, ack) => {
    if (socket.data.role !== 'gm') return;
    const result = gameState.saveLoginImage((payload || {}).dataUrl);
    if (result.ok) broadcastState();
    if (typeof ack === 'function') ack(result.ok ? { ok: true, url: result.url } : { ok: false, reason: result.reason });
  });

  socket.on('loginimg:reset', (payload, ack) => {
    if (socket.data.role !== 'gm') return;
    const result = gameState.resetLoginImage();
    if (result.ok) broadcastState();
    if (typeof ack === 'function') ack(result.ok ? { ok: true } : { ok: false, reason: result.reason });
  });

  // Свои готовые картинки героев/NPC (data/presets): { name, dataUrl } / { url }. Только мастер.
  socket.on('preset:upload', (payload, ack) => {
    if (socket.data.role !== 'gm') return;
    const { name, dataUrl } = payload || {};
    const result = gameState.saveUserPreset(name, dataUrl);
    if (typeof ack === 'function') ack(result.ok ? { ok: true, url: result.url } : { ok: false, reason: result.reason });
  });

  socket.on('preset:remove', (payload, ack) => {
    if (socket.data.role !== 'gm') return;
    const result = gameState.removeUserPreset((payload || {}).url);
    if (result.ok) broadcastState(); // у героев и NPC с этой картинкой аватар сброшен
    if (typeof ack === 'function') ack(result.ok ? { ok: true } : { ok: false, reason: result.reason });
  });

  // Каталог навыков: { name, icon, description, oldName? } / { name }. Переименование и удаление проходят по героям.
  socket.on('skill:save', (payload, ack) => {
    if (socket.data.role !== 'gm') return;
    const result = gameState.saveSkill(payload);
    if (result.ok) broadcastState();
    if (typeof ack === 'function') ack(result.ok ? { ok: true } : { ok: false, reason: result.reason });
  });

  socket.on('skill:remove', (payload, ack) => {
    if (socket.data.role !== 'gm') return;
    const result = gameState.removeSkill((payload || {}).name);
    if (result.ok) broadcastState();
    if (typeof ack === 'function') ack(result.ok ? { ok: true } : { ok: false, reason: result.reason });
  });

  // Ролики (панель «Ролики», только ГМ; ответ — ack). Загрузка кусками: begin → chunk × N → end (server/videos.js).
  const ackWith = (ack, result) => { if (typeof ack === 'function') ack(result); };

  socket.on('video:upload:begin', (payload, ack) => {
    if (socket.data.role !== 'gm') return;
    ackWith(ack, videos.begin(socket.id, payload));
  });

  socket.on('video:upload:chunk', (payload, ack) => {
    if (socket.data.role !== 'gm') return;
    const { uploadId, index, data } = payload || {};
    ackWith(ack, videos.chunk(socket.id, uploadId, index, data));
  });

  socket.on('video:upload:end', (payload, ack) => {
    if (socket.data.role !== 'gm') return;
    const result = videos.finish(socket.id, (payload || {}).uploadId);
    if (result.ok) broadcastState(); // список роликов у ГМ обновился
    ackWith(ack, result);
  });

  socket.on('video:upload:abort', (payload, ack) => {
    if (socket.data.role !== 'gm') return;
    ackWith(ack, videos.abort(socket.id, (payload || {}).uploadId));
  });

  // Показ: у всех открывается окно (state.video → public/js/videofx.js); остановка закрывает его у всех сразу.
  // Сервер сам снимает показ, когда ролик доиграл (+ запас): клиенты закрывают окно и по своему «ended».
  socket.on('video:play', (payload, ack) => {
    if (socket.data.role !== 'gm') return;
    const result = gameState.playVideo((payload || {}).id);
    if (result.ok) {
      scheduleVideoExpiry(result.duration);
      broadcastState();
    }
    ackWith(ack, result.ok ? { ok: true } : { ok: false, reason: result.reason });
  });

  socket.on('video:stop', (payload, ack) => {
    if (socket.data.role !== 'gm') return;
    clearVideoExpiry();
    if (gameState.stopVideo()) broadcastState();
    ackWith(ack, { ok: true });
  });

  socket.on('video:remove', (payload, ack) => {
    if (socket.data.role !== 'gm') return;
    const result = gameState.removeVideo((payload || {}).id);
    if (result.wasPlaying) clearVideoExpiry();
    if (result.ok) broadcastState();
    ackWith(ack, result.ok ? { ok: true } : { ok: false, reason: 'not-found' });
  });

  socket.on('item:give', ({ characterId, item }) => {
    if (socket.data.role !== 'gm') return;
    gameState.giveItem(characterId, item);
    broadcastState();
  });

  socket.on('item:remove', ({ characterId, index }) => {
    if (socket.data.role !== 'gm') return;
    gameState.removeItem(characterId, index);
    broadcastState();
  });

  socket.on('character:add', ({ data }) => {
    if (socket.data.role !== 'gm') return;
    gameState.addCharacter(data);
    broadcastState();
  });

  socket.on('character:remove', ({ characterId }) => {
    if (socket.data.role !== 'gm') return;
    gameState.removeCharacter(characterId);
    broadcastState();
  });

  socket.on('character:update', ({ characterId, data }) => {
    if (socket.data.role !== 'gm') return;
    gameState.updateCharacter(characterId, data);
    broadcastState();
  });

  socket.on('move', ({ characterId, x, y }, ack) => {
    const result = gameState.moveCharacter(characterId, { x, y });
    if (typeof ack === 'function') ack(result);
    if (result.ok) broadcastState();
  });

  socket.on('move:gm', ({ characterId, x, y }, ack) => {
    if (socket.data.role !== 'gm') return;
    const result = gameState.forceMoveCharacter(characterId, { x, y });
    if (typeof ack === 'function') ack(result);
    if (result.ok) broadcastState();
  });

  socket.on('reachable', ({ characterId }, ack) => {
    if (typeof ack === 'function') ack(gameState.getReachableCells(characterId));
  });

  // Локации — создаёт/переключает/удаляет только мастер.
  socket.on('location:add', ({ name }, ack) => {
    if (socket.data.role !== 'gm') return;
    const location = gameState.addLocation(name);
    if (typeof ack === 'function') ack({ ok: !!location, location });
    if (location) broadcastState();
  });

  socket.on('location:rename', ({ locationId, name }) => {
    if (socket.data.role !== 'gm') return;
    gameState.renameLocation(locationId, name);
    broadcastState();
  });

  // Порядок локаций: ГМ переставляет выбранную на позицию toIndex (0-based).
  socket.on('location:move', ({ locationId, toIndex }) => {
    if (socket.data.role !== 'gm') return;
    if (gameState.moveLocation(locationId, toIndex)) broadcastState();
  });

  // Переключение локации отдельно шлёт fog:update — иначе клиенты не узнают
  // про туман новой локации до следующей правки тумана мастером (тот же
  // принцип, что при 'join').
  socket.on('location:switch', ({ locationId }) => {
    if (socket.data.role !== 'gm') return;
    const previousLocationId = gameState.getActiveLocationId();
    if (gameState.setActiveLocation(locationId)) {
      // Предложения картинок привязаны к прежней сцене — при реальной смене отменяем все.
      if (gameState.getActiveLocationId() !== previousLocationId) {
        gameState.clearImageProposals().forEach((p) => closeImageProposal(p, 'cancelled'));
      }
      io.emit('fog:update', { blob: gameState.getFog() });
      broadcastState();
    }
  });

  socket.on('location:remove', ({ locationId }, ack) => {
    if (socket.data.role !== 'gm') return;
    const result = gameState.removeLocation(locationId);
    if (typeof ack === 'function') ack(result);
    if (result.ok) broadcastState();
  });

  socket.on('party:restore', () => {
    if (socket.data.role !== 'gm') return;
    gameState.restorePartyResources();
    broadcastState();
  });

  // Боевой режим: включает/выключает и ведёт только мастер.
  socket.on('combat:start', ({ participants }) => {
    if (socket.data.role !== 'gm') return;
    const combat = gameState.startCombat(participants);
    // combat:started шлём раньше broadcastState — клиенты должны узнать
    // «бой начинается» и отложить показ итогового порядка хода до конца
    // анимации кубиков, а не увидеть его раньше, чем она доиграет.
    // Игрокам — с замаскированными именами скрытых NPC, ГМ — с настоящими.
    if (combat.active && combat.order.length) {
      io.to('players').emit('combat:started', { order: gameState.publicCombatOrder(combat.order) });
      io.to('gm').emit('combat:started', { order: combat.order });
    }
    broadcastState();
  });

  socket.on('combat:end', () => {
    if (socket.data.role !== 'gm') return;
    gameState.endCombat();
    gameState.restorePartyEnergy();
    broadcastState();
  });

  socket.on('combat:next', () => {
    if (socket.data.role !== 'gm') return;
    gameState.nextTurn();
    broadcastState();
  });

  socket.on('combat:damage', ({ targetType, targetId, amount }) => {
    if (socket.data.role !== 'gm') return;
    gameState.applyDamage(targetType, targetId, amount);
    broadcastState();
  });

  // Саундборд: без состояния и без ГМ-гейта — любой участник запускает звук
  // для всех, сервер лишь ретранслирует id (сам файл выбирает клиент по манифесту).
  socket.on('sound:play', ({ soundId, label }) => {
    if (typeof soundId !== 'string' || !soundId) return;
    io.emit('sound:play', { soundId });
    const safeLabel = typeof label === 'string' && label.trim() ? label.trim().slice(0, config.SOUND_LABEL_MAX_LENGTH) : soundId;
    gameState.addChatMessage(socket.data.name, `запускает звук «${safeLabel}»`, 'system', gameState.isCharacterDead(socket.data.characterId));
    broadcastState();
  });

  // Музыка: только мастер выбирает/играет/ставит на паузу/останавливает —
  // состояние (трек+позиция) общее для всех, рассылается вместе с остальным
  // state через broadcastState (см. gameState.state.music).
  socket.on('music:play', ({ trackId }) => {
    if (socket.data.role !== 'gm') return;
    gameState.setMusicTrack(trackId);
    broadcastState();
  });

  socket.on('music:pause', () => {
    if (socket.data.role !== 'gm') return;
    gameState.pauseMusic();
    broadcastState();
  });

  socket.on('music:resume', () => {
    if (socket.data.role !== 'gm') return;
    gameState.playMusic();
    broadcastState();
  });

  socket.on('music:stop', () => {
    if (socket.data.role !== 'gm') return;
    gameState.stopMusic();
    broadcastState();
  });

  // Круг до сервера для блока «ресурсы» (public/js/perfhud.js, «Пинг»): сразу отвечаем пустым ack, ничего не читаем и не меняем.
  socket.on('net:ping', (payload, ack) => {
    if (typeof ack === 'function') ack();
  });

  // Режим «что делать, когда трек доиграл» (повтор / по списку / случайно) — общий для всех.
  socket.on('music:mode', ({ mode }) => {
    if (socket.data.role !== 'gm') return;
    if (gameState.setMusicMode(mode)) broadcastState();
  });

  // Перемотка на секунду position: клиенты сами подгоняют свой <audio> под серверную позицию.
  socket.on('music:seek', ({ position }) => {
    if (socket.data.role !== 'gm') return;
    if (gameState.seekMusic(position)) broadcastState();
  });

  // Следующий/предыдущий трек: кнопки ГМа и автосмена по окончании трека (auto — шлёт страница ГМа на 'ended').
  // from — трек, который клиент считал играющим (устаревший клик и событие от второго окна ГМа игнорируются).
  socket.on('music:next', ({ dir, from, auto }) => {
    if (socket.data.role !== 'gm') return;
    if (gameState.skipMusicTrack(dir === -1 ? -1 : 1, from, auto === true)) broadcastState();
  });

  // Загрузка/удаление звуков и треков — только мастер. Манифест не приватный,
  // поэтому обновление шлём всем через io.emit, а не по комнатам gm/players.
  socket.on('sound:upload', ({ name, dataUrl }, ack) => {
    if (socket.data.role !== 'gm') {
      if (typeof ack === 'function') ack({ ok: false });
      return;
    }
    const entry = gameState.addSound(name, dataUrl);
    if (typeof ack === 'function') ack({ ok: !!entry, entry });
    if (entry) io.emit('sound:manifest-updated');
  });

  socket.on('sound:remove', ({ id }) => {
    if (socket.data.role !== 'gm') return;
    if (gameState.removeSound(id)) io.emit('sound:manifest-updated');
  });

  socket.on('music:upload', ({ name, dataUrl }, ack) => {
    if (socket.data.role !== 'gm') {
      if (typeof ack === 'function') ack({ ok: false });
      return;
    }
    const entry = gameState.addMusicTrack(name, dataUrl);
    if (typeof ack === 'function') ack({ ok: !!entry, entry });
    if (entry) io.emit('music:manifest-updated');
  });

  socket.on('music:remove', ({ id }) => {
    if (socket.data.role !== 'gm') return;
    const result = gameState.removeMusicTrack(id);
    if (result.removed) io.emit('music:manifest-updated');
    if (result.wasPlaying) broadcastState();
  });

  // Общий чат: свободный текст от ГМ и игроков, без гейта — пишут все.
  // Текст, начинающийся с "/", трактуется как консольная команда —
  // /help и ответ на нераспознанную команду уходят приватно только
  // отправителю (socket.emit('chat:notice', ...)), не в общий broadcastState.
  socket.on('chat:send', ({ text }) => {
    if (typeof text !== 'string') return;
    const trimmed = text.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('/')) {
      const [rawCmd, ...rest] = trimmed.slice(1).split(/\s+/);
      const cmd = rawCmd.toLowerCase();
      const argStr = rest.join(' ');

      if (cmd === 'help') {
        socket.emit('chat:notice', { text: CHAT_HELP_TEXT });
        return;
      }
      if (cmd === 'roll' || cmd === 'r') {
        const parsed = gameState.parseDiceExpression(argStr);
        if (!parsed) {
          socket.emit('chat:notice', { text: `Не понял выражение «${argStr || ''}». Пример: /roll 2d6+3` });
          return;
        }
        const rollText = gameState.formatFreeRoll(parsed.count, parsed.sides, parsed.mod);
        gameState.addChatMessage(socket.data.name, rollText, 'system', gameState.isCharacterDead(socket.data.characterId));
        broadcastState();
        return;
      }
      if (cmd === 'me') {
        if (!argStr) return;
        gameState.addChatMessage(socket.data.name, argStr, 'emote', gameState.isCharacterDead(socket.data.characterId));
        broadcastState();
        return;
      }
      socket.emit('chat:notice', { text: `Неизвестная команда «/${cmd}». Наберите /help.` });
      return;
    }

    gameState.addChatMessage(socket.data.name, text, 'user', gameState.isCharacterDead(socket.data.characterId));
    broadcastState();
  });

  socket.on('chat:clear', () => {
    if (socket.data.role !== 'gm') return;
    gameState.clearChat();
    broadcastState();
  });

  socket.on('npc:hp', ({ npcId, delta }) => {
    if (socket.data.role !== 'gm') return;
    gameState.adjustNpcHp(npcId, delta);
    broadcastState();
  });

  socket.on('npc:energy:update', ({ npcId, delta }) => {
    if (socket.data.role !== 'gm') return;
    gameState.adjustNpcEnergy(npcId, delta);
    broadcastState();
  });

  socket.on('npc:armor:update', ({ npcId, delta }) => {
    if (socket.data.role !== 'gm') return;
    gameState.adjustNpcArmor(npcId, delta);
    broadcastState();
  });

  // Видимость NPC для игроков и статус "убит" — переключает только мастер.
  socket.on('npc:visible:set', ({ npcId, visible }) => {
    if (socket.data.role !== 'gm') return;
    gameState.setNpcVisible(npcId, visible);
    broadcastState();
  });

  // Скрыть имя NPC от игроков (они видят «Неизвестный»): маска — в gameState.getPublicState.
  socket.on('npc:namehidden:set', (payload) => {
    if (socket.data.role !== 'gm') return;
    const { npcId, hidden } = payload || {};
    gameState.setNpcNameHidden(npcId, hidden);
    broadcastState();
  });

  socket.on('npc:dead:set', ({ npcId, dead }) => {
    if (socket.data.role !== 'gm') return;
    gameState.setNpcDead(npcId, dead);
    broadcastState();
  });

  // Статус NPC (враг/союзник/нейтрал) — меняет только мастер.
  socket.on('npc:faction:set', ({ npcId, faction }) => {
    if (socket.data.role !== 'gm') return;
    gameState.setNpcFaction(npcId, faction);
    broadcastState();
  });

  socket.on('npc:move:gm', ({ npcId, x, y }, ack) => {
    if (socket.data.role !== 'gm') return;
    const result = gameState.forceMoveNpc(npcId, { x, y });
    if (typeof ack === 'function') ack(result);
    if (result.ok) broadcastState();
  });

  // Перенос NPC в другую локацию — только мастер (компаньон следует за партией и т.п.).
  socket.on('npc:location:set', ({ npcId, locationId }) => {
    if (socket.data.role !== 'gm') return;
    gameState.setNpcLocation(npcId, locationId);
    broadcastState();
  });

  socket.on('npc:item:give', ({ npcId, item }) => {
    if (socket.data.role !== 'gm') return;
    gameState.giveNpcItem(npcId, item);
    broadcastState();
  });

  socket.on('npc:item:remove', ({ npcId, index }) => {
    if (socket.data.role !== 'gm') return;
    gameState.removeNpcItem(npcId, index);
    broadcastState();
  });

  socket.on('npc:add', ({ data }) => {
    if (socket.data.role !== 'gm') return;
    gameState.addNpc(data);
    broadcastState();
  });

  socket.on('npc:remove', ({ npcId }) => {
    if (socket.data.role !== 'gm') return;
    gameState.removeNpc(npcId);
    broadcastState();
  });

  socket.on('npc:update', ({ npcId, data }) => {
    if (socket.data.role !== 'gm') return;
    gameState.updateNpc(npcId, data);
    broadcastState();
  });

  socket.on('npc:avatar:set', ({ npcId, presetUrl }) => {
    if (socket.data.role !== 'gm') return;
    if (presetUrl !== null && !gameState.isAvatarPresetUrl(presetUrl)) return; // null — убрать картинку
    gameState.setNpcAvatar(npcId, presetUrl);
    broadcastState();
  });

  socket.on('npc:avatar:upload', ({ npcId, dataUrl }, ack) => {
    if (socket.data.role !== 'gm') {
      if (typeof ack === 'function') ack({ ok: false });
      return;
    }
    const url = gameState.saveUploadedNpcAvatar(npcId, dataUrl);
    if (typeof ack === 'function') ack({ ok: !!url, url });
    if (url) broadcastState();
  });

  socket.on('disconnect', () => {
    videos.abortAllFor(socket.id); // оборвали посреди загрузки ролика — недокачанное стираем
    gameState.releaseSocket(socket.id);
    broadcastState();
  });
});

const PORT = config.PORT;
server.listen(PORT, () => {
  console.log(`Игровой движок запущен на порту ${PORT}`);
  console.log(`Игроки: http://<IP-хоста>:${PORT}/player.html`);
  console.log(`Мастер:  http://<IP-хоста>:${PORT}/gm.html`);
});
