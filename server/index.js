const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const gameState = require('./gameState');
const config = require('./config');

const app = express();
const server = http.createServer(app);
// maxHttpBufferSize поднят под загрузку музыкальных треков через dataURL
// (base64 + JSON-обвязка над MUSIC_UPLOAD_MAX_SIZE из config.js) — дефолт
// Socket.IO (~1 МБ) слишком мал даже для существующих mp3-треков (5-13 МБ).
const io = new Server(server, { maxHttpBufferSize: 30 * 1024 * 1024 });

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
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

  socket.on('join', ({ role, name, characterId, code }, ack) => {
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
    if (gameState.rollDamage(rollerId, sides, 'Мастер')) broadcastState(); // sides — строго число из DAMAGE_DICE
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

  socket.on('avatar:set', ({ characterId, presetUrl }) => {
    // Разрешаем только заранее заготовленные пресеты (защита от произвольных URL).
    if (typeof presetUrl !== 'string' || !/^\/avatars\/presets\/[\w.-]+\.svg$/.test(presetUrl)) return;
    gameState.setCharacterAvatar(characterId, presetUrl);
    broadcastState();
  });

  socket.on('avatar:upload', ({ characterId, dataUrl }, ack) => {
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
    const { id, x, y, scale, rotation, locked, flipX, flipY } = payload || {};
    if (socket.data.role === 'gm') {
      gameState.updateMapImage(id, { x, y, scale, rotation, locked, flipX, flipY });
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
      const result = gameState.updateOwnedMapImage(id, socket.data.characterId, { x, y, scale, rotation, flipX, flipY });
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
    io.emit('vfx:play', { type, x, y });
  });

  // Погода на экране — одна на всю игру, задаёт только мастер: { mode, intensity }.
  // Рисует клиент (public/js/weather.js); значения проверяет setWeather.
  socket.on('weather:set', (payload) => {
    if (socket.data.role !== 'gm') return;
    if (gameState.setWeather(payload)) broadcastState();
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
    if (typeof presetUrl !== 'string' || !/^\/avatars\/presets\/[\w.-]+\.svg$/.test(presetUrl)) return;
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
