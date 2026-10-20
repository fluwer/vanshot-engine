// Браузеры не дают запускать звук (Audio.play(), AudioContext), пока на странице не было клика, нажатия клавиши или
// касания: перезагрузка и новая вкладка сбрасывают это. Приветствие сцены и фоновая музыка при открытии страницы
// упираются именно в это — звук надо запустить сразу после первого жеста пользователя.
// window.AudioUnlock:
//   isActive()    — на странице уже был жест (звук разрешён);
//   onUnlock(fn)  — вызвать fn при ближайшем жесте. Одна и та же функция не копится (набор): музыка просит это на
//                   каждой рассылке state, пока заблокирована. fn сама решает, что делать, если звук всё ещё
//                   запрещён (повторно встать в очередь) — у клика несколько событий подряд, и «разрешающим»
//                   становится не первое из них (у мыши pointerdown ещё не активация, mousedown/click — уже да).
(function () {
  const pending = new Set();
  let seenGesture = false;

  function isActive() {
    const ua = navigator.userActivation;
    return ua ? !!ua.hasBeenActive : seenGesture;
  }

  function onGesture(e) {
    // Esc — не «активирующая» клавиша: ни звука не разрешает, ни очередь не стоит тратить.
    if (e.type === 'keydown' && e.key === 'Escape') return;
    seenGesture = true;
    if (!pending.size) return;
    const run = Array.from(pending);
    pending.clear();
    run.forEach((fn) => {
      try { fn(); } catch (err) { console.warn('AudioUnlock:', err); }
    });
  }

  ['mousedown', 'pointerup', 'click', 'keydown', 'touchend'].forEach((type) => {
    document.addEventListener(type, onGesture, true);
  });

  window.AudioUnlock = {
    isActive,
    onUnlock(fn) { if (typeof fn === 'function') pending.add(fn); },
  };
})();
