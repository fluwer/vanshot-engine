// Приветствие сцены: при любой смене локации и при каждой перезагрузке страницы —
// полноэкранный fade-in с названием локации, звук и кнопка «Продолжить» под
// названием. Обычный не-модульный скрипт (как combatfx.js), без сборки.
//
// Определяется на клиенте по state.activeLocationId (оно уже есть у ГМ и у
// игрока): первый вызов onState и каждая смена id показывают приветствие,
// реконнект с той же локацией — нет (синглтон помнит последний id). «Продолжить»
// закрывает оверлей только у себя, на сервер ничего не шлётся.
(function () {
  const overlay = document.getElementById('scene-intro-overlay');
  if (!overlay) {
    window.sceneFx = { onState() {} };
    return;
  }

  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  // Кнопка «Продолжить» появляется с задержкой (CSS-анимация) и до этого момента
  // не нажимается — чтобы приветствие не закрыли случайным кликом/Enter.
  const READY_MS = 1500;
  const READY_MS_REDUCED = 400;

  let lastLocationId = null;
  let readyTimer = null;
  let ready = false;

  // ---- Звук ---------------------------------------------------------------
  // Есть public/assets/sfx/scene-enter.mp3 — играем его; нет — синтез WebAudio
  // (низкий нарастающий «брасс»-дрон, затем металлический «пинг» и хвост-эхо):
  // файлов не нужно, работает офлайн. Браузер может не разрешить звук до
  // первого клика (перезагрузка страницы без взаимодействия) — тогда звук
  // тихо пропускается, оверлей работает как обычно.
  const SOUND_URL = 'assets/sfx/scene-enter.mp3';
  let soundFile = null;
  fetch(SOUND_URL, { method: 'HEAD' })
    .then((r) => {
      if (r.ok) {
        soundFile = new Audio(SOUND_URL);
        soundFile.preload = 'auto';
        soundFile.volume = 0.5;
      }
    })
    .catch(() => {});

  let audioCtx = null;

  function playSynth() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    audioCtx = audioCtx || new AudioCtx();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const ctx = audioCtx;
    const t0 = ctx.currentTime + 0.03;

    // Выход: сухой сигнал + эхо с затуханием (дёшево имитирует большое помещение).
    const master = ctx.createGain();
    master.gain.value = 0.35;
    const echo = ctx.createDelay(1);
    echo.delayTime.value = 0.28;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.42;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2200;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    master.connect(ctx.destination);
    master.connect(echo);
    echo.connect(damp);
    damp.connect(feedback);
    feedback.connect(echo);
    damp.connect(wet);
    wet.connect(ctx.destination);

    // Дрон: расстроенные пилы + треугольник, фильтр медленно открывается и закрывается.
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.Q.value = 4;
    droneFilter.frequency.setValueAtTime(180, t0);
    droneFilter.frequency.exponentialRampToValueAtTime(1400, t0 + 1.6);
    droneFilter.frequency.exponentialRampToValueAtTime(300, t0 + 3.4);
    const droneGain = ctx.createGain();
    droneGain.gain.setValueAtTime(0.0001, t0);
    droneGain.gain.exponentialRampToValueAtTime(0.9, t0 + 1.2);
    droneGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.6);
    [[110, 'sawtooth', -6, 0.5], [110.7, 'sawtooth', 5, 0.5], [165, 'triangle', 0, 0.35]].forEach(([freq, type, detune, level]) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g);
      g.connect(droneFilter);
      osc.start(t0);
      osc.stop(t0 + 3.7);
    });
    droneFilter.connect(droneGain);
    droneGain.connect(master);

    // Металлический «пинг»: два синуса с негармоничным отношением частот — как колокол.
    const pingAt = t0 + 1.25;
    [[880, 1], [2428.8, 0.35]].forEach(([freq, level]) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, pingAt);
      g.gain.exponentialRampToValueAtTime(0.6 * level, pingAt + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, pingAt + 1.6);
      osc.connect(g);
      g.connect(master);
      osc.start(pingAt);
      osc.stop(pingAt + 1.7);
    });
  }

  function playSceneSound() {
    try {
      if (soundFile) {
        soundFile.currentTime = 0;
        soundFile.play().catch(() => {});
      } else {
        playSynth();
      }
    } catch (err) { /* звук необязателен */ }
  }

  // ---- Оверлей ------------------------------------------------------------
  function onKey(e) {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function close() {
    if (!ready) return;
    clearTimeout(readyTimer);
    ready = false;
    overlay.classList.remove('show', 'ready');
    document.removeEventListener('keydown', onKey, true);
  }

  function show(name) {
    clearTimeout(readyTimer);
    ready = false;
    overlay.classList.remove('show', 'ready');
    document.removeEventListener('keydown', onKey, true);

    // Название вводит ГМ — только textContent, никакого innerHTML с данными.
    overlay.innerHTML = '';
    const inner = document.createElement('div');
    inner.className = 'scene-intro-inner';
    const kicker = document.createElement('div');
    kicker.className = 'scene-intro-kicker';
    kicker.textContent = 'Локация';
    const title = document.createElement('div');
    title.className = 'scene-intro-title';
    title.textContent = name || 'Новая локация';
    const line = document.createElement('div');
    line.className = 'scene-intro-line';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scene-intro-continue';
    button.textContent = 'Продолжить';
    button.addEventListener('click', close);
    inner.append(kicker, title, line, button);
    overlay.appendChild(inner);
    overlay.setAttribute('aria-label', 'Локация: ' + (name || ''));

    // Перезапуск CSS-анимаций, если оверлей уже был открыт.
    void overlay.offsetWidth;
    overlay.classList.add('show');
    document.addEventListener('keydown', onKey, true);
    playSceneSound();

    readyTimer = setTimeout(() => {
      ready = true;
      overlay.classList.add('ready');
      button.focus();
    }, reduceMotion && reduceMotion.matches ? READY_MS_REDUCED : READY_MS);
  }

  window.sceneFx = {
    // Вызывается на каждый state (и один раз при входе игрока): показывает
    // приветствие при первом вызове и при каждой смене активной локации.
    onState(state) {
      if (!state || !state.activeLocationId) return;
      if (state.activeLocationId === lastLocationId) return;
      lastLocationId = state.activeLocationId;
      show(state.activeLocationName);
    },
  };
})();
