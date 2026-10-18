// Журнал: один блок «Чат | Броски» за кнопкой 💬 справа внизу (и у ГМ, и у игрока).
// Независим от левой панели Dock. Чат (chat.js) и лог бросков (DiceLogPanel.vue)
// остаются как есть — журнал владеет только контейнером, вкладками, бейджем
// непрочитанных и короткими «всплывашками» над кнопкой.
//
//  - Непрочитанные считаются по чат-сообщениям других людей (kind user/emote);
//    системные («запускает звук…») и свои броски — шум, их не считаем.
//  - Первый снимок состояния и первый после реконнекта молча помечают историю
//    виденной (журнал.skipNext(), как diceFx.skipNext) — иначе после перезагрузки
//    страницы всплыла бы вся история.
//  - Грабли: renderChat() пока лента скрыта (display:none) видит нулевые размеры,
//    поэтому при открытии журнала и возврате на вкладку «Чат» лента явно
//    прокручивается вниз.
(function () {
  const PEEK_MS = 6000;
  const PEEK_MAX = 3;
  const SEEN_TRIM_AT = 400;

  let btn;
  let badge;
  let peek;
  let panel;
  let chatTabBtn;
  let tabs;
  let isOpen = false;
  let unread = 0;
  let primed = false;
  let skip = false;
  let seen = new Set();

  function chatVisible() {
    return isOpen && tabs && tabs.current() === 'chat';
  }

  function scrollFeed() {
    const feed = document.getElementById('chat-feed');
    if (feed) feed.scrollTop = feed.scrollHeight;
  }

  function updateBadge() {
    if (!badge) return;
    badge.hidden = unread === 0;
    badge.textContent = unread > 9 ? '9+' : String(unread);
    if (chatTabBtn) chatTabBtn.textContent = unread > 0 && isOpen ? `💬 Чат · ${unread}` : '💬 Чат';
  }

  function clearPeek() {
    if (peek) peek.textContent = '';
  }

  function markRead() {
    unread = 0;
    updateBadge();
  }

  function setOpen(value) {
    isOpen = value;
    panel.classList.toggle('open', isOpen);
    btn.classList.toggle('active', isOpen);
    btn.setAttribute('aria-pressed', isOpen ? 'true' : 'false');
    if (isOpen) {
      clearPeek();
      if (tabs.current() === 'chat') {
        markRead();
        // Лента только что стала видимой — размеры появятся после раскладки.
        requestAnimationFrame(() => {
          scrollFeed();
          const input = document.getElementById('chat-input');
          if (input) input.focus();
        });
      } else {
        updateBadge();
      }
    } else {
      const active = document.activeElement;
      if (active && panel.contains(active)) active.blur();
      updateBadge();
    }
  }

  function showPeek(entries) {
    entries.forEach((entry) => {
      const line = document.createElement('div');
      line.className = 'journal-peek-line';
      const author = document.createElement('strong');
      const name = entry.dead ? `${entry.author} ☠` : entry.author;
      author.textContent = entry.kind === 'emote' ? `* ${name} ` : `${name}: `;
      line.append(author, document.createTextNode(entry.text));
      line.addEventListener('click', () => setOpen(true));
      peek.appendChild(line);
      while (peek.childElementCount > PEEK_MAX) peek.removeChild(peek.firstChild);
      setTimeout(() => {
        line.classList.add('out');
        setTimeout(() => line.remove(), 350);
      }, PEEK_MS);
    });
  }

  function onState(state) {
    const chat = (state && state.chat) || [];
    const fresh = [];
    chat.forEach((entry) => {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        fresh.push(entry);
      }
    });
    if (seen.size > SEEN_TRIM_AT) seen = new Set(chat.map((e) => e.id));
    if (!primed || skip) {
      primed = true;
      skip = false;
      return;
    }
    const counted = fresh.filter((e) => e.kind === 'user' || e.kind === 'emote');
    if (!counted.length) return;
    if (chatVisible()) return; // уже читают — chat.js сам доскроллит ленту
    unread += counted.length;
    updateBadge();
    if (!isOpen) showPeek(counted.slice(-PEEK_MAX));
  }

  function init() {
    btn = document.getElementById('journal-btn');
    badge = document.getElementById('journal-badge');
    peek = document.getElementById('journal-peek');
    panel = document.getElementById('journal-panel');
    if (!btn || !panel) return;
    chatTabBtn = panel.querySelector('.dock-tabs [data-tab="chat"]');
    tabs = window.Dock.initTabs(panel, (name) => {
      if (name === 'chat') {
        markRead();
        requestAnimationFrame(scrollFeed);
      }
    });
    btn.addEventListener('click', () => setOpen(!isOpen));
    panel.querySelector('.dock-close')?.addEventListener('click', () => setOpen(false));
    // Esc внутри журнала закрывает его (Dock этот Esc пропускает). Подсказки команд
    // чата (/…) закрываются тем же Esc сначала — их видимость смотрим по display.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !isOpen) return;
      if (!(e.target instanceof Element) || !e.target.closest('#journal-panel')) return;
      const suggest = document.getElementById('chat-suggest');
      if (suggest && suggest.style.display === 'block') return;
      setOpen(false);
    });
    updateBadge();
  }

  window.journal = {
    onState,
    skipNext() { skip = true; },
    open() { setOpen(true); },
    close() { setOpen(false); },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
