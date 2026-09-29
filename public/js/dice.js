// Единый формат строки лога/детали броска: явно подписывает, что с чем
// складывается (иконка кубика, иконка+название атрибута, бонус решимости, DC),
// чтобы не было непонятного "0+0+0".
const ATTR_ICONS = { body: '💪', mind: '🧠', charisma: '💬' };
const ATTR_LABELS = { body: 'Тело', mind: 'Разум', charisma: 'Харизма' };

function formatDiceEntry(entry) {
  const parts = [`🎲${entry.die}`];
  if (entry.attribute) {
    const icon = ATTR_ICONS[entry.attribute] || '🔹';
    const label = ATTR_LABELS[entry.attribute] || entry.attribute;
    const sign = entry.attrValue >= 0 ? '+' : '';
    parts.push(`${icon} ${label} ${sign}${entry.attrValue}`);
  }
  if (entry.resolveBonus) parts.push(`✨ Решимость +${entry.resolveBonus}`);
  const dcText = entry.dc ? ` · 🎯 DC ${entry.dc} — ${entry.success ? '✅ успех' : '❌ провал'}` : '';
  return `${entry.characterName}: ${parts.join(' + ')} = ${entry.total}${dcText}`;
}
window.formatDiceEntry = formatDiceEntry;

// Простая визуальная анимация броска: кубик "подкидывается" (CSS-анимация),
// а число несколько раз мигает случайными значениями перед тем как показать
// настоящий результат броска.
function initDiceStage(containerEl) {
  containerEl.innerHTML = `
    <div class="dice-cube">🎲</div>
    <div class="dice-number">—</div>
    <div class="dice-detail"></div>
  `;
  const cube = containerEl.querySelector('.dice-cube');
  const number = containerEl.querySelector('.dice-number');
  const detail = containerEl.querySelector('.dice-detail');
  let interval = null;

  function show(entry, onDone) {
    if (interval) clearInterval(interval);

    cube.classList.remove('rolling');
    void cube.offsetWidth;
    cube.classList.add('rolling');

    // Тихий звук броска — файл кладёт сам ГМ в assets/sfx/, как и с combat-start.mp3;
    // без файла .play() просто молча зафейлится.
    const sound = new Audio('assets/sfx/dice-roll.mp3');
    sound.volume = 0.25;
    sound.play().catch(() => {});

    number.className = 'dice-number';
    detail.textContent = '';

    let ticks = 0;
    const maxTicks = 12;
    interval = setInterval(() => {
      ticks += 1;
      number.textContent = String(1 + Math.floor(Math.random() * 20));
      if (ticks >= maxTicks) {
        clearInterval(interval);
        interval = null;
        number.textContent = String(entry.die);
        number.classList.add('landed');
        if (entry.critical === 'success') number.classList.add('crit-success');
        if (entry.critical === 'fail') number.classList.add('crit-fail');

        detail.textContent = formatDiceEntry(entry);
        if (typeof onDone === 'function') onDone();
      }
    }, 60);
  }

  return { show };
}

window.initDiceStage = initDiceStage;
