// Единый формат строки лога/детали броска: явно подписывает, что с чем складывается
// (кубик, иконка+название атрибута, бонус решимости, DC), чтобы не было непонятного "0+0+0".
// Строка собирается из ЧАСТЕЙ — { text } или { icon, cls } (иконки из public/js/icons.js вместо
// эмодзи); их рисуют renderDiceParts (DOM) и DiceLogPanel.vue (v-for + <Icon>). Имена
// бросающего вводят люди — текст всегда идёт через textContent/createTextNode, не через HTML.

function attrIconName(attr) {
  return (window.ATTR_ICONS && window.ATTR_ICONS[attr]) || 'diamond';
}
function attrLabel(attr) {
  return (window.ATTR_LABELS && window.ATTR_LABELS[attr]) || attr;
}

// Полная строка (лог бросков и подпись кубика инициативы):
// «Имя: [d20] 12 + [тело] Тело +2 + [✦] Решимость +1 = 15 · [цель] DC 14 — [✓] успех».
function diceEntryParts(entry) {
  const parts = [{ text: entry.characterName }];
  if (entry.dead) parts.push({ icon: 'skull', cls: 'ico-dead' }); // бросок убитого — с меткой
  // Кубик урона dN (entry.type === 'damage'): «Имя: [меч] Урон d6: 4» — без атрибута, DC и критов.
  if (entry.type === 'damage') {
    parts.push({ text: ': ' }, { icon: 'sword', cls: 'ico-fail' }, { text: ` Урон d${entry.sides}: ${entry.die}` });
    return parts;
  }
  parts.push({ text: ': ' }, { icon: 'd20' }, { text: ` ${entry.die}` });
  if (entry.attribute) {
    const sign = entry.attrValue >= 0 ? '+' : '';
    parts.push({ text: ' + ' }, { icon: attrIconName(entry.attribute) },
      { text: ` ${attrLabel(entry.attribute)} ${sign}${entry.attrValue}` });
  }
  if (entry.resolveBonus) {
    const resolve = window.Game.res('resolve');
    parts.push({ text: ' + ' }, { icon: resolve.icon, cls: 'ico-amber' }, { text: ` ${resolve.label} +${entry.resolveBonus}` });
  }
  parts.push({ text: ` = ${entry.total}` });
  if (entry.dc) {
    parts.push({ text: ' · ' }, { icon: 'target' }, { text: ` DC ${entry.dc} — ` },
      { icon: entry.success ? 'circle-check' : 'circle-x', cls: entry.success ? 'ico-ok' : 'ico-fail' },
      { text: entry.success ? ' успех' : ' провал' });
  }
  return parts;
}

// Компактная строка под числом на кубике (diceFx.js): «12 [тело] +2 [✦] +1 · DC 14 [✓]».
function diceChipParts(entry) {
  if (entry.type === 'damage') return [{ icon: 'sword', cls: 'ico-fail' }, { text: ` Урон d${entry.sides}` }];
  const parts = [{ text: String(entry.die) }];
  if (entry.attribute) {
    const sign = entry.attrValue >= 0 ? '+' : '−';
    parts.push({ text: ' ' }, { icon: attrIconName(entry.attribute) }, { text: ` ${sign}${Math.abs(entry.attrValue)}` });
  }
  if (entry.resolveBonus) parts.push({ text: ' ' }, { icon: window.Game.res('resolve').icon, cls: 'ico-amber' }, { text: ` +${entry.resolveBonus}` });
  if (entry.dc) {
    parts.push({ text: ` · DC ${entry.dc} ` },
      { icon: entry.success ? 'circle-check' : 'circle-x', cls: entry.success ? 'ico-ok' : 'ico-fail' });
  }
  return parts;
}

// Рисует части в DOM-узел (старое содержимое не трогает — очищайте сами).
function renderDiceParts(parent, parts) {
  parts.forEach((p) => {
    if (p.icon) {
      const el = window.Icons.el(p.icon, { cls: p.cls });
      if (el) parent.appendChild(el);
    } else {
      parent.appendChild(document.createTextNode(p.text));
    }
  });
}

window.diceEntryParts = diceEntryParts;
window.diceChipParts = diceChipParts;
window.renderDiceParts = renderDiceParts;

// Простая визуальная анимация броска: кубик "подкидывается" (CSS-анимация),
// а число несколько раз мигает случайными значениями перед тем как показать
// настоящий результат броска.
function initDiceStage(containerEl) {
  containerEl.innerHTML = `
    <div class="dice-cube">${window.Icons.svg('d20')}</div>
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

    // Тихий звук броска: свой звук ГМ (настройки игры) или стандартный assets/sfx/dice-roll.mp3;
    // без файла .play() просто молча зафейлится.
    const dice = window.Game.sfx('diceRoll');
    const sound = new Audio(dice.url);
    sound.volume = 0.25 * dice.volume;
    sound.play().catch(() => {});

    number.className = 'dice-number';
    detail.textContent = '';

    let ticks = 0;
    const maxTicks = 12;
    interval = setInterval(() => {
      ticks += 1;
      number.textContent = String(1 + Math.floor(Math.random() * ((window.Game.config.check || {}).die || 20)));
      if (ticks >= maxTicks) {
        clearInterval(interval);
        interval = null;
        number.textContent = String(entry.die);
        number.classList.add('landed');
        if (entry.critical === 'success') number.classList.add('crit-success');
        if (entry.critical === 'fail') number.classList.add('crit-fail');

        detail.textContent = '';
        renderDiceParts(detail, diceEntryParts(entry));
        if (typeof onDone === 'function') onDone();
      }
    }, 60);
  }

  return { show };
}

window.initDiceStage = initDiceStage;
