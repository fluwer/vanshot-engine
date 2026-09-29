// Эффект «Начать бой»: разом «прилетают» кубики инициативы всех участников
// (по одному на каждого, с настоящим d20+Тело — как в остальных проверках,
// см. initDiceStage/formatDiceEntry из dice.js) + звук. Срабатывает у всех
// клиентов по transient-событию combat:started (не входит в постоянный
// state — не повторяется при реконнекте).
//
// Тайминги увеличены в 1.5 раза относительно базовых (220/1800мс), чтобы
// анимация ощущалась не такой поспешной.
const COMBAT_FX_STAGGER = 330;      // интервал между стартами кубиков
const COMBAT_FX_DIE_DURATION = 1170; // оценка времени одного кубика (тиканье+посадка, см. dice.js)
const COMBAT_FX_HOLD = 2700;        // сколько держим оверлей после приземления последнего кубика

// opts.onStart/opts.onEnd — вызываются в начале/конце анимации, чтобы вызывающий
// код (gm.js/player.js) мог отложить обновление панели «Бой» до её завершения —
// иначе итоговый порядок хода виден раньше, чем долетели кубики.
function initCombatStartFx(socket, opts) {
  const { onStart, onEnd } = opts || {};
  const overlay = document.getElementById('combat-start-overlay');
  if (!overlay) return;
  let hideTimer = null;

  socket.on('combat:started', ({ order }) => {
    if (!Array.isArray(order) || !order.length) return;
    if (hideTimer) clearTimeout(hideTimer);

    if (typeof onStart === 'function') onStart();

    new Audio('assets/sfx/combat-start.mp3').play().catch(() => {}); // файл кладёт сам ГМ — без него просто тихо

    overlay.innerHTML = '<h2 class="combat-start-title">⚔️ Инициатива!</h2><div class="combat-start-row"></div>';
    const row = overlay.querySelector('.combat-start-row');
    overlay.classList.add('show');

    let lastDone = 0;
    order.forEach((entry, i) => {
      const cell = document.createElement('div');
      cell.className = 'dice-stage combat-die';
      row.appendChild(cell);
      const stage = initDiceStage(cell);
      const delay = i * COMBAT_FX_STAGGER; // «кубики летят» друг за другом, а не все разом
      const doneAt = delay + COMBAT_FX_DIE_DURATION;
      if (doneAt > lastDone) lastDone = doneAt;
      setTimeout(() => {
        stage.show({
          die: entry.die,
          attribute: 'body',
          attrValue: entry.initiative - entry.die,
          characterName: entry.name,
          total: entry.initiative,
          critical: entry.die === 20 ? 'success' : entry.die === 1 ? 'fail' : null,
        });
      }, delay);
    });

    hideTimer = setTimeout(() => {
      overlay.classList.remove('show');
      if (typeof onEnd === 'function') onEnd();
    }, lastDone + COMBAT_FX_HOLD);
  });
}
window.initCombatStartFx = initCombatStartFx;
