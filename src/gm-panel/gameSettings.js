// Общие помощники экрана «Игра» (GameSettingsPanel и его вкладки): отправка событий настроек с ответом
// сервера (ack) и понятный текст отказа. Проверку значений делает сервер (server/gameConfig.js) — здесь
// только разбор его причин.

const REASON_TEXT = [
  [/^invalid:title/, 'Название: от 1 до 60 символов'],
  [/^invalid:subtitle/, 'Подзаголовок: не длиннее 80 символов'],
  [/^invalid:hiddenName/, 'Имя скрытого NPC: от 1 до 30 символов'],
  [/^invalid:theme/, 'Цвет задан неверно'],
  [/^invalid:sfx/, 'Звук задан неверно'],
  [/\.icon$/, 'Такой иконки нет в наборе'],
  [/\.short$/, 'Короткая подпись: от 1 до 8 символов'],
  [/^invalid:(attributes|resources|factions)/, 'Подпись: от 1 до 24 символов; цвет — в формате #rrggbb'],
  [/^invalid:check\.crit/, 'Пороги критов должны лежать в пределах кубика, а провал — быть ниже успеха'],
  [/^invalid:check\.dcPresets/, 'Пресеты сложности: до 6 штук, значения от 1 до 40, подпись до 16 символов'],
  [/^invalid:check\.damageDice/, 'Выберите хотя бы один кубик урона'],
  [/^invalid:check/, 'Параметры проверок заданы неверно'],
  [/^save-failed/, 'Сервер не смог записать файл настроек'],
  [/^too-large/, 'Файл слишком большой'],
  [/^bad-format/, 'Неподходящий формат файла'],
  [/^limit/, 'Достигнут предел количества'],
  [/^exists/, 'Такое уже есть'],
  [/^not-found/, 'Не найдено — обновите страницу'],
  [/^invalid:name/, 'Название навыка: от 1 до 40 символов, без служебных слов'],
  [/^invalid:description/, 'Описание: не длиннее 400 символов'],
  [/^invalid:icon/, 'Такой иконки нет в наборе'],
  [/^no-response/, 'Сервер не ответил'],
];

export function reasonText(reason) {
  const r = String(reason || '');
  const hit = REASON_TEXT.find(([re]) => re.test(r));
  return hit ? hit[1] : (r ? `Не принято: ${r}` : 'Не принято сервером');
}

// Событие с ack: Promise<{ ok, reason?, ...поля ответа }>. Ответа нет 8 секунд — { ok: false, reason: 'no-response' }.
export function request(socket, event, payload) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, reason: 'no-response' }); } }, 8000);
    socket.emit(event, payload, (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result && typeof result === 'object' ? result : { ok: false, reason: 'no-response' });
    });
  });
}

// Короткое сообщение пользователю (тосты public/js/imagetools.js; запасной вариант — alert).
export function toast(message, kind = 'info') {
  if (window.imageTools && typeof window.imageTools.notify === 'function') window.imageTools.notify(message, kind);
  else window.alert(message);
}

// Сохранить правку настроек: показывает отказ и возвращает true при успехе.
export async function saveGame(socket, patch, okMessage = 'Сохранено') {
  const result = await request(socket, 'game:update', patch);
  if (!result.ok) {
    toast(reasonText(result.reason), 'error');
    return false;
  }
  if (okMessage) toast(okMessage, 'info');
  return true;
}

export async function resetGame(socket, section, okMessage = 'Возвращено к примеру') {
  const result = await request(socket, 'game:reset', { section });
  if (!result.ok) {
    toast(reasonText(result.reason), 'error');
    return false;
  }
  if (okMessage) toast(okMessage, 'info');
  return true;
}

// Файл → dataURL (для загрузки звука на сервер).
export function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
}
