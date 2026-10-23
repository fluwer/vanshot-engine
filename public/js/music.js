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
//
// Синхронность между участниками (ориентир — 0,1…0,2 с): позиция трека считается от серверного startedAt, поэтому
// (1) клиент меряет сдвиг своих часов относительно серверных (net:ping возвращает серверное время) и считает по serverNow(),
// (2) расхождение между звуком и серверной позицией («дрейф») проверяется каждые 500 мс, а не только на рассылке state:
// большое (> 0,6 с) выправляется перемоткой, малое — плавной подстройкой скорости ±4% (тон не меняется), см. syncMusicTime.

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

// Подгонка позиции (секунды дрейфа, доли скорости, мс).
const MUSIC_HARD_SEEK_S = 0.6;      // дрейф больше — перемотка
const MUSIC_SETTLE_SEEK_S = 0.25;   // то же в первые секунды после старта/смены/перемотки: докачка отставила звук — сразу догоняем
const MUSIC_SETTLE_MS = 5000;       // сколько длится «разгон» после того, как звук реально пошёл
const MUSIC_SEEK_LEAD_S = 0.05;     // перемотка целится чуть вперёд: пока декодер встаёт на место, позиция уходит на столько же
const MUSIC_DEAD_ZONE_S = 0.03;     // дрейф меньше — не трогаем; больше — подстраиваем скорость
const MUSIC_REST_ZONE_S = 0.02;     // уже подстраиваем: вернуть скорость 1, когда дрейф стал меньше (гистерезис)
const MUSIC_RATE_FIX_S = 2;         // постоянная времени подстройки: поправка скорости = дрейф / 2 с (с потолком ±4%)
const MUSIC_MAX_RATE_DELTA = 0.04;  // скорость не отличается от 1 больше чем на 4%
const MUSIC_PAUSED_SEEK_S = 0.3;    // на паузе перематываем при расхождении больше (звука нет — рывка не слышно)
const MUSIC_TICK_MS = 500;
const MUSIC_SEEK_BURST = 2;         // подряд перемоток без передышки (запас на «встали, докачали, догнали»)
const MUSIC_SEEK_REFILL_MS = 4000;  // и по одной новой раз в 4 с: файлы с неточной перемоткой (VBR mp3) не зациклят её

// Часы: сдвиг серверного времени относительно клиентского.
const CLOCK_BURST = 6;              // замеров подряд при подключении
const CLOCK_BURST_GAP_MS = 150;
const CLOCK_REFRESH_MS = 20000;     // дальше по два замера раз в 20 с
const CLOCK_MAX_AGE_MS = 60000;     // старше — образец не берём (часы клиента могли подвести стрелки)
const CLOCK_MAX_SAMPLES = 16;
const CLOCK_WAIT_MS = 1500;         // не дождались ответа сервера (старый сервер) — играем по несдвинутым часам

let clockOffset = 0;                // серверное время − клиентское, мс
let clockSamples = [];              // { rtt, offset, at } — лучшим считаем образец с наименьшим rtt
let clockSocket = null;
let clockReady = false;             // есть первый образец (или ждать больше нечего): можно запускать звук
let musicTickTimer = null;
let seekTokens = MUSIC_SEEK_BURST;
let seekTokenAt = 0;
let settleUntil = 0;                // до какого performance.now() действует строгий порог перемотки
let settlePending = false;          // был старт/смена/перемотка: «разгон» отсчитываем от момента, когда звук пошёл ('playing')
let hardSeeks = 0;                 // сколько раз выправляли перемоткой (для проверок)
let lastDrift = null;               // последний посчитанный дрейф, с (для проверок)
let lastSyncKey = null;             // что мы уже применили (трек, старт, пауза): перемотка по state — только при его смене

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

const serverNow = () => Date.now() + clockOffset;

// Замер: клиент помнит свои Date.now()/performance.now() в момент отправки, сервер отвечает своим Date.now().
// Половина круга — оценка пути до сервера, остальное — сдвиг часов. Лучшим берём образец с наименьшим кругом.
function pingClockOnce(socket) {
  if (!socket || !socket.connected) return;
  const wall = Date.now();
  const t0 = performance.now();
  socket.emit('net:ping', t0, (serverTs) => {
    const t1 = performance.now();
    const rtt = t1 - t0;
    if (typeof serverTs !== 'number' || !Number.isFinite(serverTs) || rtt < 0 || rtt > 5000) return;
    clockSamples = clockSamples.filter((s) => t1 - s.at < CLOCK_MAX_AGE_MS);
    clockSamples.push({ rtt, offset: serverTs - (wall + rtt / 2), at: t1 });
    if (clockSamples.length > CLOCK_MAX_SAMPLES) clockSamples.shift();
    clockOffset = clockSamples.reduce((best, s) => (s.rtt < best.rtt ? s : best)).offset;
    markClockReady();
  });
}

function measureClock(socket, count) {
  for (let i = 0; i < count; i++) setTimeout(() => pingClockOnce(socket), i * CLOCK_BURST_GAP_MS);
}

// Первый образец получен: звук, который ждал часы, запускаем с верной позиции (иначе пришлось бы перематывать дважды).
function markClockReady() {
  if (clockReady) return;
  clockReady = true;
  if (lastMusicState) applyMusicState(lastMusicState);
}

function startClockSync(socket) {
  if (!socket || clockSocket === socket) return;
  clockSocket = socket;
  const begin = () => { clockSamples = []; measureClock(socket, CLOCK_BURST); };
  if (socket.connected) begin();
  socket.on('connect', begin);
  setInterval(() => measureClock(socket, 2), CLOCK_REFRESH_MS);
  setTimeout(markClockReady, CLOCK_WAIT_MS);
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
    // Подстройка скорости (syncMusicTime) не должна менять высоту тона; в современных браузерах это и так по умолчанию.
    musicAudio.preservesPitch = true;
    // Звук пошёл (после старта, перемотки или докачки): теперь отсчитываем «разгон» со строгим порогом перемотки.
    musicAudio.addEventListener('playing', () => {
      if (settlePending) { settlePending = false; settleUntil = performance.now() + MUSIC_SETTLE_MS; }
    });
    // Number(null) === 0: без проверки на null у нового посетителя (ничего ещё не сохранено) музыка стартовала бы с нуля.
    let raw = null;
    try { raw = localStorage.getItem('musicVolume'); } catch (e) { /* хранилище закрыто — громкость по умолчанию */ }
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

function setMusicRate(audio, rate) {
  if (audio.playbackRate !== rate) audio.playbackRate = rate;
}

// Перемотка тратит «жетон»: два подряд без передышки, дальше по одному раз в MUSIC_SEEK_REFILL_MS. Так докачка после
// первого прыжка может выправиться вторым, а файл, который перематывается неточно, не заставит скакать каждые полсекунды.
function takeSeekToken() {
  const t = performance.now();
  seekTokens = Math.min(MUSIC_SEEK_BURST, seekTokens + (t - seekTokenAt) / MUSIC_SEEK_REFILL_MS);
  seekTokenAt = t;
  if (seekTokens < 1) return false;
  seekTokens -= 1;
  return true;
}

// Подгоняет звук под серверную позицию. Дрейф = currentTime − где должны быть по серверным часам (serverNow()):
//  • играет, |дрейф| > MUSIC_HARD_SEEK_S — перемотка; force (смена трека/старта/паузы, перемотка ГМа, загрузка метаданных)
//    перематывает всегда, периодическая проверка — пока есть жетон (takeSeekToken);
//  • играет, MUSIC_DEAD_ZONE_S < |дрейф| ≤ порога — плавная подстройка скорости ±MUSIC_MAX_RATE_DELTA (звук опережает —
//    чуть медленнее, отстаёт — чуть быстрее; тон сохраняется), у ровного хода скорость возвращается к 1;
//  • пауза — перемотка при расхождении > MUSIC_PAUSED_SEEK_S, скорость 1.
// Без force звук трогаем, только когда он реально идёт (не пауза, не перемотка, данных хватает): докачка — не дрейф.
// В повторе позиция оборачивается по длительности (дрейф приводится к ±dur/2: переход по кругу — не скачок); в режимах
// без повтора за концом трека — «доиграл» (возвращает true): на конце не вызываем play(), иначе браузер перезапустил бы
// трек с нуля и клиенты рассинхронизировались; ГМ в этот момент просит сервер включить следующий (requestAutoNext).
function syncMusicTime(audio, music, force) {
  const elapsed = music.playing ? (serverNow() - music.startedAt) / 1000 : music.pausedAt;
  const dur = audio.duration;
  const hasDur = !!(dur && isFinite(dur) && dur > 0);
  const noLoop = isNoLoopMode(music);
  if (noLoop && hasDur && elapsed >= dur) {
    if (!audio.paused) audio.pause();
    setMusicRate(audio, 1);
    requestAutoNext(music);
    return true;
  }
  const target = noLoop ? Math.max(0, elapsed) : (hasDur ? ((elapsed % dur) + dur) % dur : Math.max(0, elapsed));
  let drift = audio.currentTime - target;
  if (!noLoop && hasDur) drift = ((((drift + dur / 2) % dur) + dur) % dur) - dur / 2;
  lastDrift = drift;
  const abs = Math.abs(drift);

  if (!music.playing) {
    setMusicRate(audio, 1);
    if (abs > MUSIC_PAUSED_SEEK_S) audio.currentTime = target;
    return false;
  }
  if (!force && (audio.paused || audio.seeking || audio.readyState < 3)) return false;
  if (force) { settlePending = true; settleUntil = performance.now() + MUSIC_SETTLE_MS; }
  if (abs > (performance.now() < settleUntil ? MUSIC_SETTLE_SEEK_S : MUSIC_HARD_SEEK_S)) {
    if (takeSeekToken() || force) {
      hardSeeks++;
      settlePending = true;
      const to = target + MUSIC_SEEK_LEAD_S;
      audio.currentTime = !noLoop && hasDur ? to % dur : to;
      setMusicRate(audio, 1);
    }
    return false;
  }
  const adjusting = audio.playbackRate !== 1;
  if (abs < (adjusting ? MUSIC_REST_ZONE_S : MUSIC_DEAD_ZONE_S)) setMusicRate(audio, 1);
  else setMusicRate(audio, 1 - Math.max(-MUSIC_MAX_RATE_DELTA, Math.min(MUSIC_MAX_RATE_DELTA, drift / MUSIC_RATE_FIX_S)));
  return false;
}

// Регулярная проверка дрейфа, пока музыка играет: рассылка state приходит от случайных действий и может молчать минутами.
function musicTick() {
  const m = lastMusicState;
  if (!musicAudio || !m || !m.trackId || !m.playing) { stopMusicTick(); return; }
  syncMusicTime(musicAudio, m, false);
}

function ensureMusicTick() {
  if (!musicTickTimer) musicTickTimer = setInterval(musicTick, MUSIC_TICK_MS);
}

function stopMusicTick() {
  if (musicTickTimer) clearInterval(musicTickTimer);
  musicTickTimer = null;
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
    setMusicRate(audio, 1);
    stopMusicTick();
    lastSyncKey = null;
    musicCurrentFile = null;
    if (musicNowPlayingEl) musicNowPlayingEl.textContent = 'Тишина';
    renderMusicControls(prev);
    return;
  }
  const track = trackById(music.trackId);
  if (!track) return; // манифест ещё не подгрузился — применим позже, при следующем state
  // Часы клиента ещё не сверены с серверными (первые миллисекунды после загрузки): не начинаем с неверной позиции.
  // markClockReady() вызовет нас снова.
  if (!clockReady) { renderMusicControls(prev); return; }
  let force = false;
  if (musicCurrentFile !== track.file) {
    audio.pause();
    audio.src = `assets/music/${track.file}`;
    setMusicRate(audio, 1);
    musicCurrentFile = track.file;
    force = true;
    // Позицию подгоняем по самому свежему state: пока трек грузился, мог прийти другой.
    audio.addEventListener('loadedmetadata', () => {
      if (lastMusicState && lastMusicState.trackId === music.trackId) syncMusicTime(audio, lastMusicState, true);
    }, { once: true });
  }
  // Перемотка по state — только когда изменилось то, что задаёт позицию (трек, старт, пауза); дальше ведёт регулярная проверка.
  const syncKey = `${music.trackId}|${music.startedAt}|${music.pausedAt}|${music.playing}`;
  if (syncKey !== lastSyncKey) { lastSyncKey = syncKey; force = true; }
  if (music.playing && audio.paused) force = true; // звук ещё не пошёл (автоплей ждёт жеста): ставим на верное место до play()
  const finished = syncMusicTime(audio, music, force);
  if (music.playing && !finished) {
    audio.play().catch((err) => {
      // Автоплей заблокирован до жеста пользователя (перезагрузка страницы): первый клик/клавиша запускает музыку
      // (retryMusic одна и та же функция — очередь не копится на каждой рассылке state).
      if (err && err.name === 'NotAllowedError' && window.AudioUnlock) window.AudioUnlock.onUnlock(retryMusic);
    });
    ensureMusicTick();
  } else {
    audio.pause();
    setMusicRate(audio, 1);
    stopMusicTick();
  }
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
  startClockSync(socket);

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
      try { localStorage.setItem('musicVolume', String(v)); } catch (e) { /* приватный режим — настройка живёт до перезагрузки */ }
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
  ? { paused: musicAudio.paused, ended: musicAudio.ended, currentTime: musicAudio.currentTime, duration: musicAudio.duration, loop: musicAudio.loop, src: musicAudio.src, playbackRate: musicAudio.playbackRate }
  : null);
// Для проверок: сверка часов (сдвиг, круг до сервера, число образцов), дрейф, скорость, число перемоток, живёт ли таймер.
window.getMusicSyncDebug = () => ({
  offsetMs: clockOffset,
  rttMs: clockSamples.length ? clockSamples.reduce((best, s) => (s.rtt < best.rtt ? s : best)).rtt : null,
  samples: clockSamples.length,
  ready: clockReady,
  drift: lastDrift,
  rate: musicAudio ? musicAudio.playbackRate : null,
  hardSeeks,
  ticking: !!musicTickTimer,
  serverNow: serverNow(),
});
