// Общие инструменты для картинок на клиенте (ГМ и игрок): кодирование файла
// перед отправкой, разбор буфера обмена (Ctrl+V), лёгкий тост-уведомление.
// Обычный не-модульный скрипт (как combatfx.js), подключается в gm.html и
// player.html; Vue-панель ГМ берёт его через window.imageTools.
(function () {
  const MAX_SIDE = 1600;                       // максимальная сторона после сжатия (как раньше)
  const RETRY_SIDE = 1200;                     // если результат не влез в серверный лимит
  const RAW_FILE_LIMIT = 25 * 1024 * 1024;     // сырой файл больше — не декодируем (защита от зависания)
  const SERVER_LIMIT_BYTES = 5 * 1024 * 1024;  // = MAP_IMAGE_UPLOAD_MAX_SIZE в server/config.js
  const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']; // SVG не берём: у него бывает размер 0×0
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось прочитать картинку')); };
      img.src = url;
    });
  }

  // Есть ли в canvas хоть один не полностью непрозрачный пиксель.
  function hasAlpha(ctx, w, h) {
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return true;
    }
    return false;
  }

  // Аватар героя/NPC из файла: обрезка до квадрата size×size (по горизонтали центр, по вертикали
  // чуть выше центра — на портретах там лицо) и PNG — прозрачность сохраняется (JPEG дал бы чёрный
  // фон). Маленькую картинку не растягиваем. Токен рисует аватар кругом, поэтому квадрат — единственный
  // формат, который не сплющивается. Бросает Error с текстом для пользователя.
  async function avatarFromFile(file, size) {
    if (!file || !ALLOWED_TYPES.includes(file.type)) throw new Error('Это не картинка (поддерживаются PNG, JPEG, WebP, GIF)');
    if (file.size > RAW_FILE_LIMIT) throw new Error('Файл слишком большой (больше 25 МБ)');
    const img = await loadImage(file);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error('Не удалось прочитать картинку');
    const side = Math.min(w, h);
    const out = Math.max(1, Math.min(size || 128, side));
    const canvas = document.createElement('canvas');
    canvas.width = out;
    canvas.height = out;
    canvas.getContext('2d').drawImage(img, (w - side) / 2, (h - side) * 0.25, side, side, 0, 0, out, out);
    return canvas.toDataURL('image/png');
  }

  // Файл → { dataUrl, w, h } для отправки на сервер. Бросает Error с текстом для пользователя.
  // Без прозрачности — JPEG 0.85, как раньше; с прозрачностью — WebP (Safari вернёт PNG,
  // он тоже держит альфу), иначе вырезанные PNG получили бы чёрный фон.
  async function encodeFile(file) {
    if (!file || !ALLOWED_TYPES.includes(file.type)) throw new Error('Это не картинка (поддерживаются PNG, JPEG, WebP, GIF)');
    if (file.size > RAW_FILE_LIMIT) throw new Error('Файл слишком большой (больше 25 МБ)');
    const img = await loadImage(file);
    const srcW = img.naturalWidth;
    const srcH = img.naturalHeight;
    if (!srcW || !srcH) throw new Error('Не удалось прочитать картинку');
    for (const side of [MAX_SIDE, RETRY_SIDE]) {
      const scale = Math.min(1, side / Math.max(srcW, srcH));
      const w = Math.max(1, Math.round(srcW * scale));
      const h = Math.max(1, Math.round(srcH * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = hasAlpha(ctx, w, h) ? canvas.toDataURL('image/webp', 0.9) : canvas.toDataURL('image/jpeg', 0.85);
      if (dataUrl.length * 0.75 <= SERVER_LIMIT_BYTES) return { dataUrl, w, h };
    }
    throw new Error('Картинка слишком тяжёлая даже после сжатия');
  }

  function hasImageItem(e) {
    const items = e.clipboardData && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
    return items.some((it) => it.kind === 'file' && it.type.startsWith('image/'));
  }

  // Файлы-картинки из буфера. getAsFile() нужно звать синхронно в обработчике paste,
  // до любого await — после выхода из обработчика буфер защищён.
  function clipboardImageFiles(e) {
    const items = e.clipboardData && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
    return items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean);
  }

  function isTextField(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.tagName === 'TEXTAREA' || node.isContentEditable) return true;
    return node.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((node.type || 'text').toLowerCase());
  }

  // true — вставку обрабатывать НЕ надо (и preventDefault не вызывать, чтобы обычная
  // вставка текста работала): в буфере нет картинки; фокус в текстовом поле и в
  // буфере есть текст (человек вставляет текст); открыта модалка. Картинку из
  // буфера берём и при фокусе в чате: вставлять картинку в чат бессмысленно, а
  // фокус там остаётся после каждого сообщения — иначе Ctrl+V «не работал бы».
  function shouldIgnorePaste(e) {
    if (!hasImageItem(e)) return true;
    const types = e.clipboardData && e.clipboardData.types ? Array.from(e.clipboardData.types) : [];
    if ((isTextField(e.target) || isTextField(document.activeElement)) && types.includes('text/plain')) return true;
    if (document.querySelector('.modal-backdrop')) return true;
    return false;
  }

  // Имя вставленной картинки: реальное имя файла оставляем, безликое «image.png» заменяем.
  function imageName(file) {
    const name = ((file && file.name) || '').trim();
    if (name && !/^image\.\w+$/i.test(name)) return name;
    return 'Вставка ' + new Date().toLocaleTimeString('ru-RU');
  }

  // Лёгкий тост (в проекте других уведомлений нет — ошибки шли через alert).
  function notify(text, kind) {
    let host = document.getElementById('toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-host';
      host.className = 'toast-host';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const toast = document.createElement('div');
    toast.className = 'toast ' + (kind === 'error' ? 'toast-error' : 'toast-ok');
    toast.textContent = text;
    host.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // Короткий «пинг» — сигнал ГМ о новом предложении картинки от игрока. Если
  // браузер ещё не разрешил звук (не было клика на странице) — тихо молчит.
  let pingCtx = null;
  function ping() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      pingCtx = pingCtx || new AudioCtx();
      if (pingCtx.state === 'suspended') pingCtx.resume();
      const t = pingCtx.currentTime;
      const osc = pingCtx.createOscillator();
      const gain = pingCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.exponentialRampToValueAtTime(1320, t + 0.08);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(pingCtx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    } catch (err) { /* звук необязателен */ }
  }

  window.imageTools = { encodeFile, avatarFromFile, clipboardImageFiles, shouldIgnorePaste, imageName, notify, ping };
})();
