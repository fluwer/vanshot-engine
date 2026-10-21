// Музыка: список треков — из assets/music/manifest.json (тот же принцип, что
// и у саундборда: положил файл в assets/music/, дописал манифест — без правок
// кода). Мастер выбирает трек и жмёт play/pause/stop — сервер хранит только
// id трека и позицию (см. gameState.state.music), рассылает всем через общий
// state. Каждый клиент сам крутит свой <audio>, громкость — чисто локальная
// настройка (localStorage), на сервер никогда не уходит.
//
// Что делать, когда трек доиграл, решает режим state.music.mode (общий для всех, задаёт ГМ):
//   loop — повтор того же трека (audio.loop), list — следующий по списку по кругу, shuffle — случайный.
// Длительностей треков сервер не знает, поэтому конец трека слышит страница ГМа: на 'ended' она шлёт music:next
// { dir: 1, from, auto: true }; у игроков по концу трека ничего не шлётся — они ждут новый state. Перемотка: ГМ
// двигает ползунок позиции → music:seek { position }; остальные клиенты сами подгоняют currentTime под серверную позицию.

let musicTracks = [];
let musicAudio = null;
let musicCurrentFile = null;
let musicNowPlayingEl = null;
let lastMusicState = null;
let musicSocket = null;
let musicIsGm = false;
let gmMusicUi = null;       // элементы управления ГМа: { selectEl, prev, next, seek, time, modeBtns }
let seekDragging = false;   // ГМ тянет ползунок позиции — значение не перезаписываем
let autoNextKey = null;     // 'trackId:startedAt' — на какой запуск трека автосмена уже отправлена (без дублей)

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// Громкость, которую выбрал сам пользователь (ползунок, localStorage), и «приглушение»: пока идёт окно ролика
// (public/js/videofx.js) музыка тише в musicDuck раз; после — возвращается. Ползунок всегда правит базовую.
let musicBaseVolume = 0.5;
let musicDuck = 1;

function applyMusicVolume() {
  if (musicAudio) musicAudio.volume = clamp01(musicBaseVolume * musicDuck);
}

function setMusicDuck(k) {
  musicDuck = clamp01(Number(k));
  applyMusicVolume();
}

function getMusicAudio() {
  if (!musicAudio) {
    musicAudio = new Audio();
    // Number(null) === 0: без проверки на null у нового посетителя (ничего ещё не сохранено) музыка стартовала бы с нуля.
    const raw = localStorage.getItem('musicVolume');
    const saved = raw === null ? NaN : Number(raw);
    musicBaseVolume = Number.isFinite(saved) ? clamp01(saved / 100) : 0.5;
    applyMusicVolume();
  }
  return musicAudio;
}

function trackById(id) {
  return musicTracks.find((t) => t.id === id);
}

// Режимы без повтора: по окончании трека включается другой (state.music.mode); нет mode (старый сервер) — повтор.
const isNoLoopMode = (music) => !!music && (music.mode === 'list' || music.mode === 'shuffle');

// Страница ГМа: трек доигран — просим сервер включить следующий. Один раз на запуск (trackId:startedAt):
// 'ended' и «по серверному времени уже кончился» приходят независимо и не должны давать два перехода.
function requestAutoNext(music) {
  if (!musicIsGm || !musicSocket || !music || !music.playing || !isNoLoopMode(music)) return;
  const key = `${music.trackId}:${music.startedAt}`;
  if (autoNextKey === key) return;
  autoNextKey = key;
  musicSocket.emit('music:next', { dir: 1, from: music.trackId, auto: true });
}

// Подгоняет currentTime под серверную позицию, только если разъехались больше чем на секунду — иначе дёргаем
// воспроизведение на каждое state. В повторе позиция оборачивается по длительности; в режимах без повтора за концом
// трека — «доиграл» (возвращает true): на конце не вызываем play(), иначе браузер перезапустил бы трек с нуля и
// клиенты рассинхронизировались; ГМ в этот момент просит сервер включить следующий (requestAutoNext).
function syncMusicTime(audio, music) {
  const elapsed = music.playing ? (Date.now() - music.startedAt) / 1000 : music.pausedAt;
  const dur = audio.duration;
  const hasDur = !!(dur && isFinite(dur) && dur > 0);
  if (isNoLoopMode(music)) {
    if (hasDur && elapsed >= dur) {
      if (!audio.paused) audio.pause();
      requestAutoNext(music);
      return true;
    }
    const target = Math.max(0, elapsed);
    if (Math.abs(audio.currentTime - target) > 1) audio.currentTime = target;
    return false;
  }
  const target = hasDur ? ((elapsed % dur) + dur) % dur : Math.max(0, elapsed);
  if (Math.abs(audio.currentTime - target) > 1) audio.currentTime = target;
  return false;
}

// Повтор запуска музыки после первого жеста пользователя (см. applyMusicState).
function retryMusic() {
  if (lastMusicState) applyMusicState(lastMusicState);
}

const fmtMusicTime = (s) => {
  const t = Math.max(0, Math.floor(Number(s) || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

// Ползунок позиции и подпись «1:23 / 4:05» у ГМа: показывают локальный <audio> (он и так следует за сервером).
function updateMusicSeekUi() {
  if (!gmMusicUi) return;
  const a = musicAudio;
  const has = !!(lastMusicState && lastMusicState.trackId && a && isFinite(a.duration) && a.duration > 0);
  const { seek, time } = gmMusicUi;
  seek.disabled = !has;
  if (!has) {
    seek.max = '0';
    seek.value = '0';
    time.textContent = '0:00 / 0:00';
  } else {
    seek.max = String(Math.floor(a.duration));
    if (!seekDragging) seek.value = String(Math.min(Math.floor(a.currentTime), Math.floor(a.duration)));
    time.textContent = `${fmtMusicTime(seekDragging ? Number(seek.value) : a.currentTime)} / ${fmtMusicTime(a.duration)}`;
  }
  if (window.UI) window.UI.syncRanges(seek.parentElement); // заливка ползунка до бегунка (--p): событий input при программной смене нет
}

// Кнопки ГМа по состоянию музыки: режим подсвечен, «предыдущий/следующий» доступны, пока что-то играет, список
// треков следует за играющим (когда трек сменился сам — иначе «Играть» перезапустило бы прежний выбор).
function renderMusicControls(prev) {
  if (!gmMusicUi) return;
  const m = lastMusicState;
  const has = !!(m && m.trackId);
  gmMusicUi.prev.disabled = !has;
  gmMusicUi.next.disabled = !has;
  Object.entries(gmMusicUi.modeBtns).forEach(([mode, btn]) => {
    btn.classList.toggle('active', ((m && m.mode) || 'loop') === mode);
  });
  if (has && gmMusicUi.selectEl && (!prev || prev.trackId !== m.trackId)) gmMusicUi.selectEl.value = m.trackId;
  updateMusicSeekUi();
}

// Вызывается на каждый 'state' от сервера (см. gm.js/player.js) — применяет
// текущее состояние музыки (трек/играет-ли/позиция/режим) к локальному <audio>.
function applyMusicState(music) {
  const prev = lastMusicState;
  lastMusicState = music || null;
  const audio = getMusicAudio();
  audio.loop = !isNoLoopMode(music);
  if (!music || !music.trackId) {
    audio.pause();
    musicCurrentFile = null;
    if (musicNowPlayingEl) musicNowPlayingEl.textContent = 'Тишина';
    renderMusicControls(prev);
    return;
  }
  const track = trackById(music.trackId);
  if (!track) return; // манифест ещё не подгрузился — применим позже, при следующем state
  if (musicCurrentFile !== track.file) {
    audio.pause();
    audio.src = `assets/music/${track.file}`;
    musicCurrentFile = track.file;
    // Позицию подгоняем по самому свежему state: пока трек грузился, мог прийти другой.
    audio.addEventListener('loadedmetadata', () => {
      if (lastMusicState && lastMusicState.trackId === music.trackId) syncMusicTime(audio, lastMusicState);
    }, { once: true });
  }
  const finished = syncMusicTime(audio, music);
  if (music.playing && !finished) {
    audio.play().catch((err) => {
      // Автоплей заблокирован до жеста пользователя (перезагрузка страницы): первый клик/клавиша запускает музыку
      // (retryMusic одна и та же функция — очередь не копится на каждой рассылке state).
      if (err && err.name === 'NotAllowedError' && window.AudioUnlock) window.AudioUnlock.onUnlock(retryMusic);
    });
  } else audio.pause();
  if (musicNowPlayingEl) {
    musicNowPlayingEl.textContent = `${music.playing ? 'Играет' : 'На паузе'}: ${track.label || track.id}`;
  }
  renderMusicControls(prev);
}

// opts.role — 'gm' даёт доступ к выбору трека, кнопкам play/pause/stop, режимам, перемотке и «предыдущий/следующий»,
// у игрока остаются только «сейчас играет» и своя громкость.
function initMusicPlayer(socket, opts) {
  const {
    role, selectId, playId, pauseId, stopId, deleteId, nowPlayingId, volumeId, volumeValueId,
    prevId, nextId, seekId, timeId, modeIds,
  } = opts;
  musicNowPlayingEl = nowPlayingId ? document.getElementById(nowPlayingId) : null;
  const audio = getMusicAudio();

  const volumeInput = volumeId ? document.getElementById(volumeId) : null;
  const volumeValueEl = volumeValueId ? document.getElementById(volumeValueId) : null;
  if (volumeInput) {
    const initial = Math.round(musicBaseVolume * 100);
    volumeInput.value = String(initial);
    if (volumeValueEl) volumeValueEl.textContent = String(initial);
    volumeInput.addEventListener('input', () => {
      const v = Number(volumeInput.value);
      musicBaseVolume = clamp01(v / 100);
      applyMusicVolume();
      if (volumeValueEl) volumeValueEl.textContent = String(v);
      localStorage.setItem('musicVolume', String(v));
    });
  }

  const selectEl = selectId ? document.getElementById(selectId) : null;

  function renderTrackList() {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    if (!musicTracks.length) {
      const opt = document.createElement('option');
      opt.textContent = 'Треков пока нет';
      selectEl.appendChild(opt);
      return;
    }
    musicTracks.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.label || t.id;
      selectEl.appendChild(opt);
    });
    // Список пересобран (манифест подгрузился или изменился) — выбранным остаётся играющий трек.
    if (lastMusicState && lastMusicState.trackId && trackById(lastMusicState.trackId)) selectEl.value = lastMusicState.trackId;
  }

  // Манифест теперь может меняться в рантайме (загрузка/удаление ГМом) —
  // { cache: 'no-store' }, чтобы браузер не отдавал устаревшую версию.
  function loadManifest() {
    fetch('assets/music/manifest.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])
      .then((list) => {
        musicTracks = Array.isArray(list) ? list : [];
        renderTrackList();
        if (lastMusicState) applyMusicState(lastMusicState); // манифест мог подгрузиться позже первого state
      });
  }

  loadManifest();
  socket.on('music:manifest-updated', loadManifest);

  if (role === 'gm') {
    musicIsGm = true;
    musicSocket = socket;
    const playBtn = playId ? document.getElementById(playId) : null;
    const pauseBtn = pauseId ? document.getElementById(pauseId) : null;
    const stopBtn = stopId ? document.getElementById(stopId) : null;
    const deleteBtn = deleteId ? document.getElementById(deleteId) : null;
    const prevBtn = prevId ? document.getElementById(prevId) : null;
    const nextBtn = nextId ? document.getElementById(nextId) : null;
    const seekEl = seekId ? document.getElementById(seekId) : null;
    const timeEl = timeId ? document.getElementById(timeId) : null;

    if (playBtn) {
      playBtn.addEventListener('click', () => {
        if (!selectEl || !selectEl.value) return;
        const trackId = selectEl.value;
        // Тот же трек на паузе — продолжаем с той же позиции, иначе — запускаем заново.
        if (lastMusicState && lastMusicState.trackId === trackId && !lastMusicState.playing) {
          socket.emit('music:resume');
        } else {
          socket.emit('music:play', { trackId });
        }
      });
    }
    if (pauseBtn) pauseBtn.addEventListener('click', () => socket.emit('music:pause'));
    if (stopBtn) stopBtn.addEventListener('click', () => socket.emit('music:stop'));
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        if (!selectEl || !selectEl.value) return;
        const track = trackById(selectEl.value);
        if (track && confirm(`Удалить трек «${track.label || track.id}»?`)) {
          socket.emit('music:remove', { id: selectEl.value });
        }
      });
    }

    // Предыдущий/следующий трек по списку (в режиме «Случайно» вперёд — случайный). from — трек, который мы считаем
    // играющим: сервер игнорирует устаревший клик.
    const skip = (dir) => {
      if (lastMusicState && lastMusicState.trackId) socket.emit('music:next', { dir, from: lastMusicState.trackId });
    };
    if (prevBtn) prevBtn.addEventListener('click', () => skip(-1));
    if (nextBtn) nextBtn.addEventListener('click', () => skip(1));

    // Режим «что делать, когда трек доиграл»: повтор / по списку / случайно.
    const modeBtns = {};
    Object.entries(modeIds || {}).forEach(([mode, elId]) => {
      const btn = document.getElementById(elId);
      if (!btn) return;
      modeBtns[mode] = btn;
      btn.addEventListener('click', () => socket.emit('music:mode', { mode }));
    });

    if (prevBtn && nextBtn && seekEl && timeEl) {
      gmMusicUi = { selectEl, prev: prevBtn, next: nextBtn, seek: seekEl, time: timeEl, modeBtns };
      // Ползунок позиции: пока ГМ тянет — подпись показывает выбранную секунду, перезапись из audio отключена;
      // по отпусканию — перемотка у всех (свой <audio> двигаем сразу, чтобы бегунок не отскакивал до ответа сервера).
      seekEl.addEventListener('input', () => { seekDragging = true; updateMusicSeekUi(); });
      seekEl.addEventListener('change', () => {
        seekDragging = false;
        const position = Number(seekEl.value);
        if (!lastMusicState || !lastMusicState.trackId || !Number.isFinite(position)) return;
        try { audio.currentTime = position; } catch (e) { /* метаданные ещё не загружены */ }
        socket.emit('music:seek', { position });
        updateMusicSeekUi();
      });
      ['timeupdate', 'seeked', 'loadedmetadata', 'durationchange', 'emptied'].forEach((ev) => audio.addEventListener(ev, updateMusicSeekUi));
      renderMusicControls(null);
    }

    // Трек доиграл до конца (повтор выключен): ГМ просит сервер включить следующий. У игроков этого слушателя нет.
    audio.addEventListener('ended', () => requestAutoNext(lastMusicState));
  }
}

window.initMusicPlayer = initMusicPlayer;
window.applyMusicState = applyMusicState;
window.setMusicDuck = setMusicDuck;
window.getMusicVolume = () => (musicAudio ? musicAudio.volume : null); // для проверок: фактическая громкость с приглушением
// Для проверок: фактическое состояние локального <audio> (позиция, повтор, играет ли, файл).
window.getMusicDebug = () => (musicAudio
  ? { paused: musicAudio.paused, ended: musicAudio.ended, currentTime: musicAudio.currentTime, duration: musicAudio.duration, loop: musicAudio.loop, src: musicAudio.src }
  : null);
