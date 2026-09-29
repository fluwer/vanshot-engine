// Музыка: список треков — из assets/music/manifest.json (тот же принцип, что
// и у саундборда: положил файл в assets/music/, дописал манифест — без правок
// кода). Мастер выбирает трек и жмёт play/pause/stop — сервер хранит только
// id трека и позицию (см. gameState.state.music), рассылает всем через общий
// state. Каждый клиент сам крутит свой <audio>, громкость — чисто локальная
// настройка (localStorage), на сервер никогда не уходит.

let musicTracks = [];
let musicAudio = null;
let musicCurrentFile = null;
let musicNowPlayingEl = null;
let lastMusicState = null;

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function getMusicAudio() {
  if (!musicAudio) {
    musicAudio = new Audio();
    musicAudio.loop = true;
    const saved = Number(localStorage.getItem('musicVolume'));
    musicAudio.volume = Number.isFinite(saved) ? clamp01(saved / 100) : 0.5;
  }
  return musicAudio;
}

function trackById(id) {
  return musicTracks.find((t) => t.id === id);
}

// Подгоняет currentTime под серверную позицию, только если разъехались
// больше чем на секунду — иначе дёргаем воспроизведение на каждое state.
function syncMusicTime(audio, music) {
  const elapsed = music.playing ? (Date.now() - music.startedAt) / 1000 : music.pausedAt;
  const dur = audio.duration;
  const target = (dur && isFinite(dur) && dur > 0) ? ((elapsed % dur) + dur) % dur : Math.max(0, elapsed);
  if (Math.abs(audio.currentTime - target) > 1) audio.currentTime = target;
}

// Вызывается на каждый 'state' от сервера (см. gm.js/player.js) — применяет
// текущее состояние музыки (трек/играет-ли/позиция) к локальному <audio>.
function applyMusicState(music) {
  lastMusicState = music || null;
  const audio = getMusicAudio();
  if (!music || !music.trackId) {
    audio.pause();
    musicCurrentFile = null;
    if (musicNowPlayingEl) musicNowPlayingEl.textContent = 'Тишина';
    return;
  }
  const track = trackById(music.trackId);
  if (!track) return; // манифест ещё не подгрузился — применим позже, при следующем state
  if (musicCurrentFile !== track.file) {
    audio.pause();
    audio.src = `assets/music/${track.file}`;
    musicCurrentFile = track.file;
    audio.addEventListener('loadedmetadata', () => syncMusicTime(audio, music), { once: true });
  }
  syncMusicTime(audio, music);
  if (music.playing) audio.play().catch(() => {}); // автоплей может быть заблокирован до жеста пользователя
  else audio.pause();
  if (musicNowPlayingEl) {
    musicNowPlayingEl.textContent = `${music.playing ? 'Играет' : 'На паузе'}: ${track.label || track.id}`;
  }
}

// opts.role — 'gm' даёт доступ к выбору трека и кнопкам play/pause/stop,
// у игрока остаются только «сейчас играет» и своя громкость.
function initMusicPlayer(socket, opts) {
  const { role, selectId, playId, pauseId, stopId, deleteId, nowPlayingId, volumeId, volumeValueId } = opts;
  musicNowPlayingEl = nowPlayingId ? document.getElementById(nowPlayingId) : null;
  const audio = getMusicAudio();

  const volumeInput = volumeId ? document.getElementById(volumeId) : null;
  const volumeValueEl = volumeValueId ? document.getElementById(volumeValueId) : null;
  if (volumeInput) {
    const initial = Math.round(audio.volume * 100);
    volumeInput.value = String(initial);
    if (volumeValueEl) volumeValueEl.textContent = String(initial);
    volumeInput.addEventListener('input', () => {
      const v = Number(volumeInput.value);
      audio.volume = clamp01(v / 100);
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
      opt.textContent = 'Нет треков — добавьте файлы в assets/music/ и manifest.json';
      selectEl.appendChild(opt);
      return;
    }
    musicTracks.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.label || t.id;
      selectEl.appendChild(opt);
    });
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
    const playBtn = playId ? document.getElementById(playId) : null;
    const pauseBtn = pauseId ? document.getElementById(pauseId) : null;
    const stopBtn = stopId ? document.getElementById(stopId) : null;
    const deleteBtn = deleteId ? document.getElementById(deleteId) : null;

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
  }
}

window.initMusicPlayer = initMusicPlayer;
window.applyMusicState = applyMusicState;
