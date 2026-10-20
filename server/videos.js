const fs = require('fs');
const path = require('path');
const config = require('./config');
const { writeFileAtomic } = require('./fsutil');

// Ролики: библиотека коротких видео (mp4/webm), которые ГМ загружает из интерфейса и показывает всем в общем
// окне (state.video в gameState.js, клиент — public/js/videofx.js). Здесь — только файлы и загрузка.
//   data/uploads/video/<id>.<mp4|webm>  — файлы (адрес /assets/video/…, index.js отдаёт папку через express.static
//                                          с поддержкой Range: клиент начинает с нужной секунды, не качая всё);
//   data/video-library.json             — список [{ id, label, file, size, duration, added }];
//   data/uploads/video/.tmp/<uploadId>  — недокачанное (точка в пути: static такие файлы не отдаёт).
// Всё под data/ (том Docker): переживает пересборку, в git и образ не попадает.

const DATA_DIR = path.join(__dirname, 'data');
const VIDEO_DIR = path.join(DATA_DIR, 'uploads', 'video');
const TMP_DIR = path.join(VIDEO_DIR, '.tmp');
const LIBRARY_FILE = path.join(DATA_DIR, 'video-library.json');

const FILE_NAME_RE = /^[\w-]+\.(mp4|webm)$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

// ---- Библиотека ----
function loadLibrary() {
  for (const file of [LIBRARY_FILE, `${LIBRARY_FILE}.bak`]) {
    if (!fs.existsSync(file)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!Array.isArray(raw)) continue;
      return raw
        .filter((e) => e && typeof e.id === 'string' && typeof e.file === 'string' && FILE_NAME_RE.test(e.file))
        .map((e) => ({
          id: e.id,
          label: typeof e.label === 'string' ? e.label : e.id,
          file: e.file,
          size: Number(e.size) || 0,
          duration: Number(e.duration) > 0 ? Number(e.duration) : 0,
          added: Number(e.added) || 0,
        }));
    } catch (err) {
      console.error(`Не удалось прочитать ${path.basename(file)}:`, err.message);
    }
  }
  return [];
}

const library = loadLibrary();

function saveLibrary() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomic(LIBRARY_FILE, JSON.stringify(library, null, 2));
    return true;
  } catch (err) {
    console.warn('Не удалось сохранить video-library.json:', err.message);
    return false;
  }
}

const list = () => library.map((e) => ({ ...e }));
const get = (id) => library.find((e) => e.id === id) || null;

// ---- Загрузка кусками ----
// begin → chunk × N (строго по порядку, с ack) → end. Один сокет — одна загрузка. Формат определяем по первым
// байтам файла, а не по тому, что заявил клиент: MP4 — «ftyp» на смещении 4, WebM — заголовок EBML.
const uploads = new Map();

function detectExt(head) {
  if (head.length >= 8 && head.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  return null;
}

function dropUpload(uploadId) {
  const u = uploads.get(uploadId);
  if (!u) return;
  uploads.delete(uploadId);
  try { fs.closeSync(u.fd); } catch (err) { /* уже закрыт */ }
  fs.unlink(u.tmpPath, () => {});
}

function begin(socketId, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const size = p.size;
  if (!Number.isInteger(size) || size <= 0) return { ok: false, reason: 'invalid:size' };
  if (size > config.VIDEO_UPLOAD_MAX_SIZE) return { ok: false, reason: 'too-large' };
  const duration = p.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > config.VIDEO_MAX_DURATION_SEC) {
    return { ok: false, reason: 'invalid:duration' };
  }
  if ([...uploads.values()].some((u) => u.socketId === socketId)) return { ok: false, reason: 'busy' };
  if (library.length + uploads.size >= config.VIDEO_MAX_COUNT) return { ok: false, reason: 'limit' };
  const label = (typeof p.name === 'string' ? p.name.replace(CONTROL_RE, ' ').trim() : '').slice(0, config.VIDEO_LABEL_MAX_LENGTH) || 'Ролик';
  const uploadId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const tmpPath = path.join(TMP_DIR, uploadId);
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const fd = fs.openSync(tmpPath, 'w+'); // чтение нужно в конце — прочесть сигнатуру формата
    uploads.set(uploadId, { socketId, label, size, duration, received: 0, nextIndex: 0, fd, tmpPath, last: Date.now() });
  } catch (err) {
    console.warn('Не удалось начать загрузку ролика:', err.message);
    return { ok: false, reason: 'save-failed' };
  }
  return { ok: true, uploadId };
}

function chunk(socketId, uploadId, index, data) {
  const u = typeof uploadId === 'string' ? uploads.get(uploadId) : null;
  if (!u || u.socketId !== socketId) return { ok: false, reason: 'not-found' };
  const fail = (reason) => { dropUpload(uploadId); return { ok: false, reason }; };
  if (!Buffer.isBuffer(data) || !data.length || data.length > config.VIDEO_CHUNK_MAX_SIZE) return fail('bad-chunk');
  if (index !== u.nextIndex) return fail('bad-order');
  if (u.received + data.length > u.size) return fail('too-large');
  try {
    fs.writeSync(u.fd, data);
  } catch (err) {
    console.warn('Не удалось записать кусок ролика:', err.message);
    return fail('save-failed');
  }
  u.received += data.length;
  u.nextIndex += 1;
  u.last = Date.now();
  return { ok: true, received: u.received };
}

function finish(socketId, uploadId) {
  const u = typeof uploadId === 'string' ? uploads.get(uploadId) : null;
  if (!u || u.socketId !== socketId) return { ok: false, reason: 'not-found' };
  if (u.received !== u.size) { dropUpload(uploadId); return { ok: false, reason: 'incomplete' }; }
  let ext = null;
  try {
    const head = Buffer.alloc(12);
    fs.readSync(u.fd, head, 0, 12, 0);
    ext = detectExt(head);
    fs.closeSync(u.fd);
  } catch (err) {
    dropUpload(uploadId);
    return { ok: false, reason: 'save-failed' };
  }
  uploads.delete(uploadId);
  if (!ext) {
    fs.unlink(u.tmpPath, () => {});
    return { ok: false, reason: 'bad-format' };
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const file = `${id}.${ext}`;
  try {
    fs.renameSync(u.tmpPath, path.join(VIDEO_DIR, file));
  } catch (err) {
    console.warn('Не удалось сохранить ролик:', err.message);
    fs.unlink(u.tmpPath, () => {});
    return { ok: false, reason: 'save-failed' };
  }
  const entry = { id, label: u.label, file, size: u.size, duration: Math.round(u.duration * 100) / 100, added: Date.now() };
  library.push(entry);
  if (!saveLibrary()) {
    library.pop();
    fs.unlink(path.join(VIDEO_DIR, file), () => {});
    return { ok: false, reason: 'save-failed' };
  }
  return { ok: true, entry: { ...entry } };
}

function abort(socketId, uploadId) {
  const u = typeof uploadId === 'string' ? uploads.get(uploadId) : null;
  if (u && u.socketId === socketId) dropUpload(uploadId);
  return { ok: true };
}

// Сокет отвалился посреди загрузки — стираем недокачанное.
function abortAllFor(socketId) {
  [...uploads.entries()].forEach(([uploadId, u]) => { if (u.socketId === socketId) dropUpload(uploadId); });
}

// Брошенные загрузки (кусков нет дольше VIDEO_UPLOAD_IDLE_MS).
function sweepIdle() {
  const now = Date.now();
  [...uploads.entries()].forEach(([uploadId, u]) => { if (now - u.last > config.VIDEO_UPLOAD_IDLE_MS) dropUpload(uploadId); });
}
setInterval(sweepIdle, 15 * 1000).unref();

// ---- Удаление ----
function remove(id) {
  const idx = library.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  const [entry] = library.splice(idx, 1);
  saveLibrary();
  fs.unlink(path.join(VIDEO_DIR, path.basename(entry.file)), (err) => {
    if (err && err.code !== 'ENOENT') console.warn('Не удалось удалить файл ролика:', err.message);
  });
  return true;
}

// При старте недокачанного быть не должно (прошлый процесс мог оборваться посреди загрузки).
try {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch (err) {
  console.warn('Не удалось подготовить папку роликов:', err.message);
}

module.exports = { VIDEO_DIR, list, get, begin, chunk, finish, abort, abortAllFor, remove };
