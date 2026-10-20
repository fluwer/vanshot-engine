// Окно показа роликов («событийных роликов»): ГМ запускает ролик из панели «Ролики», и у ВСЕХ — у него и у
// игроков — само открывается небольшое окно с рамкой, видео идёт автоматически; ГМ останавливает, и окно
// тут же закрывается у всех. Без подписей и не на весь экран.
//
// Сервер хранит state.video = { playId, id, url, elapsed, duration } | null (gameState.publicVideo) и рассылает
// его в каждом state; здесь — только проигрывание у себя (по образцу music.js / scenefx.js):
//  • playId — идентификатор показа: тот же ролик, запущенный повторно, начинается заново, а переподключение
//    с прежним playId ничего не перезапускает;
//  • elapsed считает сервер в момент рассылки — зашедший посреди ролика (или переподключившийся) начинает с
//    нужной секунды, часы устройств не важны; сильно отставший (> DRIFT_S) подтягивается к серверному времени;
//  • окно закрывается, когда пришёл video: null, начался другой показ или ролик доиграл (событие ended);
//  • автоплей со звуком браузер может запретить (страница открылась без жеста): тогда идёт без звука, а любой
//    клик включает звук (на время запрета в углу — значок динамика);
//  • фоновая музыка приглушается на время окна (music.js: setMusicDuck) — локально у каждого.
// API: window.videoFx.init({ gm, onStop }) — у ГМ в рамке появляется значок «стоп»; window.videoFx.onState(video).
(function () {
  const layer = document.getElementById('video-layer');
  if (!layer) return;

  const CLOSE_MS = 160; // «тут же»: быстрое затухание окна
  const MUSIC_DUCK = 0.2; // во сколько раз тише музыка, пока окно открыто
  const DRIFT_S = 3; // насколько можно отстать от серверного времени, прежде чем подтянуться
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let isGm = false;
  let onStop = null;
  let current = null; // { playId, win, video, base, receivedAt, duration, closing, mutedByPolicy }
  // Показ, который мы закрыли сами (ролик доиграл, ГМ нажал «стоп», ошибка): пока сервер ещё не снял его из state
  // (он делает это через пару секунд после конца или по ответу на «стоп»), любая рассылка снова принесла бы тот же
  // playId — без этой метки окно открывалось бы заново и мигало.
  let closedPlayId = null;

  const duck = (k) => { if (typeof window.setMusicDuck === 'function') window.setMusicDuck(k); };

  function icon(name) {
    return (window.Icons && window.Icons.el(name)) || document.createTextNode('');
  }

  function corner(pos) {
    const c = document.createElement('i');
    c.className = `video-corner ${pos}`;
    c.setAttribute('aria-hidden', 'true');
    return c;
  }

  // Где сейчас должен быть ролик по часам сервера: elapsed на момент получения + время с тех пор.
  const targetTime = (cur) => Math.min(cur.base + (performance.now() - cur.receivedAt) / 1000, cur.duration || Infinity);

  function close(cur, immediate) {
    if (!cur || cur.closing) return;
    cur.closing = true;
    closedPlayId = cur.playId;
    if (current === cur) current = null;
    document.removeEventListener('pointerdown', cur.unmuteOnGesture, true);
    document.removeEventListener('keydown', cur.unmuteOnGesture, true);
    const remove = () => {
      try { cur.video.pause(); cur.video.removeAttribute('src'); cur.video.load(); } catch (err) { /* уже снят */ }
      cur.win.remove();
    };
    if (immediate || reduceMotion) {
      remove();
    } else {
      cur.win.classList.remove('open');
      cur.win.classList.add('closing');
      setTimeout(remove, CLOSE_MS);
    }
    if (!current) duck(1); // следующий показ (если он есть) приглушит музыку сам
  }

  function open(info) {
    const win = document.createElement('div');
    win.className = 'video-window';
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-label', 'Ролик');

    const frame = document.createElement('div');
    frame.className = 'video-frame';
    const video = document.createElement('video');
    video.className = 'video-el';
    video.setAttribute('playsinline', '');
    video.setAttribute('disablepictureinpicture', '');
    video.setAttribute('disableremoteplayback', '');
    video.setAttribute('controlslist', 'nodownload noplaybackrate noremoteplayback');
    video.preload = 'auto';
    video.controls = false;
    video.muted = false;
    frame.appendChild(video);
    win.appendChild(frame);
    ['tl', 'tr', 'bl', 'br'].forEach((p) => win.appendChild(corner(p)));

    const cur = {
      playId: info.playId,
      win,
      video,
      base: Number(info.elapsed) || 0,
      receivedAt: performance.now(),
      duration: Number(info.duration) || 0,
      closing: false,
      mutedByPolicy: false,
    };

    if (isGm) {
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'video-btn video-stop';
      stop.setAttribute('aria-label', 'Остановить ролик');
      stop.appendChild(icon('square'));
      stop.addEventListener('click', () => {
        close(cur); // у ГМ закрываем сразу, не дожидаясь ответа сервера
        if (typeof onStop === 'function') onStop();
      });
      win.appendChild(stop);
    }

    // Звук включают любым жестом на странице (после него браузер разрешает автоплей со звуком).
    const unmuteBtn = document.createElement('button');
    unmuteBtn.type = 'button';
    unmuteBtn.className = 'video-btn video-unmute';
    unmuteBtn.hidden = true;
    unmuteBtn.setAttribute('aria-label', 'Включить звук');
    unmuteBtn.appendChild(icon('volume-x'));
    win.appendChild(unmuteBtn);
    const unmute = () => {
      if (!cur.mutedByPolicy) return;
      cur.mutedByPolicy = false;
      video.muted = false;
      unmuteBtn.hidden = true;
      document.removeEventListener('pointerdown', cur.unmuteOnGesture, true);
      document.removeEventListener('keydown', cur.unmuteOnGesture, true);
    };
    cur.unmuteOnGesture = unmute;
    unmuteBtn.addEventListener('click', unmute);

    video.addEventListener('loadedmetadata', () => {
      if (video.videoWidth && video.videoHeight) win.style.setProperty('--ar', String(video.videoWidth / video.videoHeight));
      cur.duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : cur.duration;
      const t = targetTime(cur);
      if (cur.duration && t >= cur.duration - 0.15) { close(cur); return; } // зашли, когда ролик уже закончился
      if (t > 0.5) video.currentTime = t;
    }, { once: true });
    video.addEventListener('ended', () => close(cur));
    video.addEventListener('error', () => {
      console.warn('videoFx: ролик не воспроизводится', video.error && video.error.message);
      close(cur, true);
      if (isGm && window.imageTools) window.imageTools.notify('Ролик не воспроизводится в этом браузере', 'error');
    });

    video.src = info.url;
    layer.appendChild(win);
    current = cur;
    duck(MUSIC_DUCK);
    // «Въезжание»: класс после принудительного пересчёта стилей — без requestAnimationFrame, который во вкладке в
    // фоне не срабатывает (окно так и осталось бы прозрачным до возвращения на вкладку).
    void win.offsetWidth;
    win.classList.add('open');

    const started = video.play();
    if (started && typeof started.catch === 'function') {
      started.catch((err) => {
        if (err && err.name === 'NotAllowedError') {
          // автоплей со звуком запрещён — идём без звука и ждём жест
          cur.mutedByPolicy = true;
          video.muted = true;
          unmuteBtn.hidden = false;
          video.play().catch(() => {});
          document.addEventListener('pointerdown', cur.unmuteOnGesture, true);
          document.addEventListener('keydown', cur.unmuteOnGesture, true);
        }
        // остальное (AbortError при быстрой замене ролика) — игнорируем, окно закроет следующее состояние
      });
    }
  }

  // Рассылка с тем же playId: обычный случай ничего не делает; сильно отставшего подтягиваем к серверному времени.
  function resync(info) {
    if (!current || current.closing) return;
    current.base = Number(info.elapsed) || 0;
    current.receivedAt = performance.now();
    const v = current.video;
    if (v.readyState >= 1 && !v.seeking && !v.ended && Math.abs(v.currentTime - current.base) > DRIFT_S && current.base < (current.duration || Infinity) - 0.3) {
      v.currentTime = current.base;
    }
  }

  function onState(info) {
    if (!info || !info.url || !info.playId) {
      closedPlayId = null; // сервер снял показ — следующий запуск (даже того же ролика) получит новый playId
      if (current) close(current);
      return;
    }
    if (info.playId === closedPlayId) return; // этот показ мы уже закрыли, сервер ещё не успел его снять
    if (current && current.playId === info.playId) { resync(info); return; }
    if (current) close(current, true); // начался другой показ — прежнее окно убираем сразу
    open(info);
  }

  // Вкладка была в фоне (таймеры и видео там притормаживают) — вернулись, подтягиваемся к серверному времени.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !current || current.closing) return;
    const v = current.video;
    const t = targetTime(current);
    if (v.readyState >= 1 && Math.abs(v.currentTime - t) > 1.5 && t < (current.duration || Infinity) - 0.3) v.currentTime = t;
    if (v.paused && !v.ended) v.play().catch(() => {});
  });

  window.videoFx = {
    init(opts) {
      isGm = !!(opts && opts.gm);
      onStop = (opts && opts.onStop) || null;
    },
    onState,
    // Для проверок: что сейчас открыто.
    debug: () => (current ? { playId: current.playId, paused: current.video.paused, muted: current.video.muted, time: current.video.currentTime, closing: current.closing } : null),
  };
}());
