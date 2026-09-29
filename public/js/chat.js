// Общий чат: свободные сообщения ГМ/игроков + системные уведомления (например,
// о звуках из саундборда). Сервер хранит и персистит всю историю (см.
// config.CHAT_HISTORY_LIMIT в engine/server/config.js) — лента показывает её
// целиком, со скроллом (см. .chat-feed в style.css).

// Приватные уведомления (/help, ошибка нераспознанной команды) — видны
// только этому клиенту, сервер их не хранит и не рассылает остальным.
// renderChat вызывается на КАЖДЫЙ state-ивент и полностью перестраивает
// ленту из state.chat — поэтому такие уведомления не кладём в DOM напрямую
// (их бы стёрло следующим же чужим сообщением), а подмешиваем сюда при
// каждом рендере, пока не вытеснятся по лимиту localNotices.
let localNotices = [];
let lastServerChat = [];

// Список команд для подсказки при вводе "/" — дублирует CHAT_HELP_TEXT из
// server/index.js (тот же приём, что и NPC_FACTIONS в NpcCard.vue/
// CombatPanel.vue: маленькая статичная константа проще продублировать,
// чем тащить через сокет).
const CHAT_COMMANDS = [
  { cmd: 'roll', hint: 'N | NdM+K — бросок кубика, например /roll 10 или /roll 2d6+3' },
  { cmd: 'me', hint: 'действие — эмоут от своего имени' },
  { cmd: 'help', hint: '— показать подсказку по командам' },
];

// chat — полный массив из state (может быть undefined до первого state-события).
function renderChat(chat) {
  lastServerChat = chat || [];
  const feed = document.getElementById('chat-feed');
  if (!feed) return;
  const list = [...lastServerChat, ...localNotices].sort((a, b) => new Date(a.time) - new Date(b.time));
  // Автоскролл вниз только если пользователь и так был у низа ленты —
  // renderChat вызывается на КАЖДЫЙ state (не только на новые сообщения),
  // так что безусловный скролл вниз мешал бы читать историю.
  const wasNearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 4;
  feed.innerHTML = '';
  // Fade-out для старых сообщений: последние CHAT_FADE_SHARP_COUNT всегда
  // чёткие (opacity 1), дальше в глубь истории плавно гаснут до минимума —
  // чтобы глаз цеплялся за недавнее, а не тонул в длинной ленте.
  const CHAT_FADE_SHARP_COUNT = 5;
  const CHAT_FADE_STEP = 0.15;
  const CHAT_FADE_MIN = 0.18;
  list.forEach((entry, i) => {
    const line = document.createElement('div');
    line.className = 'chat-line'
      + (entry.kind === 'system' ? ' chat-system' : '')
      + (entry.kind === 'emote' ? ' chat-emote' : '')
      + (entry.kind === 'notice' ? ' chat-notice' : '');
    const distanceFromEnd = list.length - 1 - i;
    if (distanceFromEnd >= CHAT_FADE_SHARP_COUNT) {
      const fadeSteps = distanceFromEnd - CHAT_FADE_SHARP_COUNT + 1;
      line.style.opacity = Math.max(CHAT_FADE_MIN, 1 - fadeSteps * CHAT_FADE_STEP);
    }
    if (entry.kind === 'emote') {
      line.appendChild(document.createTextNode(`* ${entry.author} ${entry.text} *`));
    } else if (entry.kind === 'notice') {
      line.appendChild(document.createTextNode(entry.text));
    } else {
      const author = document.createElement('span');
      author.className = 'chat-author';
      author.textContent = `${entry.author}: `;
      line.appendChild(author);
      line.appendChild(document.createTextNode(entry.text));
    }
    feed.appendChild(line);
  });
  if (wasNearBottom) feed.scrollTop = feed.scrollHeight;
}

function initChat(socket) {
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const suggestBox = document.getElementById('chat-suggest');
  if (!form || !input) return;

  // История отправленных сообщений (в т.ч. команд) — только в памяти,
  // сбрасывается при перезагрузке страницы (не критично: сессия ГМ/игрока
  // обычно не требует истории через рестарты). historyIndex === null
  // значит "сейчас не листаем историю, редактируется черновик".
  const history = [];
  let historyIndex = null;
  let historyDraft = '';

  // Подсказки команд при вводе "/" — см. CHAT_COMMANDS выше.
  let suggestItems = [];
  let suggestIndex = -1;

  function hideSuggestions() {
    suggestItems = [];
    suggestIndex = -1;
    if (suggestBox) { suggestBox.style.display = 'none'; suggestBox.innerHTML = ''; }
  }

  function renderSuggestions() {
    if (!suggestBox) return;
    suggestBox.innerHTML = '';
    suggestItems.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'chat-suggest-item' + (i === suggestIndex ? ' active' : '');
      const strong = document.createElement('strong');
      strong.textContent = `/${item.cmd} `;
      el.appendChild(strong);
      el.appendChild(document.createTextNode(item.hint));
      el.addEventListener('mousedown', (e) => {
        // mousedown, а не click — иначе input успевает потерять фокус
        // (blur) раньше, чем сработает выбор подсказки.
        e.preventDefault();
        applySuggestion(item);
      });
      suggestBox.appendChild(el);
    });
    suggestBox.style.display = suggestItems.length ? 'block' : 'none';
  }

  function applySuggestion(item) {
    input.value = `/${item.cmd} `;
    hideSuggestions();
    input.focus();
  }

  // Подсказки показываются, только пока набирается само имя команды (до
  // первого пробела) — как только начались аргументы, прятать не мешаем вводу.
  function updateSuggestions() {
    const value = input.value;
    if (!value.startsWith('/') || /\s/.test(value)) { hideSuggestions(); return; }
    const prefix = value.slice(1).toLowerCase();
    suggestItems = CHAT_COMMANDS.filter((c) => c.cmd.startsWith(prefix));
    suggestIndex = suggestItems.length ? 0 : -1;
    renderSuggestions();
  }

  input.addEventListener('input', updateSuggestions);
  input.addEventListener('blur', hideSuggestions);

  input.addEventListener('keydown', (e) => {
    if (suggestItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        suggestIndex = (suggestIndex + 1) % suggestItems.length;
        renderSuggestions();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        suggestIndex = (suggestIndex - 1 + suggestItems.length) % suggestItems.length;
        renderSuggestions();
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        applySuggestion(suggestItems[suggestIndex]);
        return;
      }
      if (e.key === 'Escape') {
        hideSuggestions();
        return;
      }
    }
    // Листание истории — только когда подсказки не открыты (иначе стрелки
    // конфликтовали бы с навигацией по списку команд выше).
    if (e.key === 'ArrowUp') {
      if (!history.length) return;
      e.preventDefault();
      if (historyIndex === null) {
        historyDraft = input.value;
        historyIndex = history.length - 1;
      } else if (historyIndex > 0) {
        historyIndex -= 1;
      }
      input.value = history[historyIndex];
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (e.key === 'ArrowDown') {
      if (historyIndex === null) return;
      e.preventDefault();
      if (historyIndex < history.length - 1) {
        historyIndex += 1;
        input.value = history[historyIndex];
      } else {
        historyIndex = null;
        input.value = historyDraft;
      }
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (history[history.length - 1] !== text) history.push(text);
    historyIndex = null;
    hideSuggestions();
    socket.emit('chat:send', { text });
    input.value = '';
  });

  // Приватный ответ сервера на /help и на нераспознанную команду —
  // см. комментарий у localNotices выше.
  socket.on('chat:notice', ({ text }) => {
    localNotices.push({ text, kind: 'notice', time: new Date().toISOString() });
    localNotices = localNotices.slice(-20); // не растим бесконечно за долгую сессию
    renderChat(lastServerChat); // немедленный локальный ререндер, не дожидаясь следующего state
  });
}

window.initChat = initChat;
window.renderChat = renderChat;
