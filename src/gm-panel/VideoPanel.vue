<script setup>
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import { request, reasonText, toast } from './gameSettings';

// Панель «Ролики» (пункт левой панели, только ГМ): библиотека коротких видео — загрузить, показать всем,
// удалить. «Показать» открывает у ВСЕХ общее окно с рамкой (public/js/videofx.js) и сразу запускает ролик;
// «Остановить» закрывает его у всех. Файлы и показ ведёт сервер (server/videos.js, state.video).
const props = defineProps({
  bridge: { type: Object, required: true },
  store: { type: Object, required: true }, // { videos: [...], video: { playId, id, … } | null }
});

const MAX_BYTES = 25 * 1024 * 1024; // как config.VIDEO_UPLOAD_MAX_SIZE
const CHUNK_BYTES = 512 * 1024; // кусок при загрузке (сервер принимает до 1 МБ)

const socket = () => props.bridge.socket;
const playingId = computed(() => (props.store.video ? props.store.video.id : null));
const playingName = computed(() => {
  const v = props.store.videos.find((x) => x.id === playingId.value);
  return v ? v.label : '';
});

const fmtDuration = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtSize = (bytes) => (bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} КБ`
  : `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`);

async function play(v) {
  const r = await request(socket(), 'video:play', { id: v.id });
  if (!r.ok) toast(reasonText(r.reason), 'error');
}

async function stop() {
  await request(socket(), 'video:stop', {});
}

async function remove(v) {
  if (!confirm(`Удалить ролик «${v.label}»?`)) return;
  const r = await request(socket(), 'video:remove', { id: v.id });
  if (!r.ok) toast(reasonText(r.reason), 'error');
}

// ---- Загрузка ----
const uploading = ref(null); // { name, percent } пока идёт загрузка
let cancelled = false;

// Длительность ролика и заодно проверка, что ЭТОТ браузер его вообще умеет декодировать (иначе ГМ загрузил бы
// файл, который потом не проиграется ни у кого).
function readDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    const done = (fn, val) => { clearTimeout(timer); probe.removeAttribute('src'); probe.load(); URL.revokeObjectURL(url); fn(val); };
    const timer = setTimeout(() => done(reject, new Error('timeout')), 10000);
    probe.preload = 'metadata';
    probe.muted = true;
    probe.onloadedmetadata = () => {
      if (Number.isFinite(probe.duration) && probe.duration > 0) { done(resolve, probe.duration); return; }
      // webm без длительности в заголовке (запись экрана, MediaRecorder): браузер узнаёт её, если промотать в конец
      probe.ondurationchange = () => { if (Number.isFinite(probe.duration) && probe.duration > 0) done(resolve, probe.duration); };
      probe.currentTime = 1e101;
    };
    probe.onerror = () => done(reject, new Error('decode'));
    probe.src = url;
  });
}

async function onFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || uploading.value) return;
  if (file.size > MAX_BYTES) {
    toast('Ролик больше 25 МБ — сожмите его и загрузите снова', 'error');
    return;
  }
  let duration;
  try {
    duration = await readDuration(file);
  } catch (err) {
    toast('Браузер не смог прочитать ролик: нужен mp4 (H.264) или webm', 'error');
    return;
  }
  const name = file.name.replace(/\.[^./\\]+$/, '');
  uploading.value = { name, percent: 0 };
  cancelled = false;
  let uploadId = null;
  try {
    const begin = await request(socket(), 'video:upload:begin', { name, size: file.size, duration });
    if (!begin.ok) throw new Error(reasonText(begin.reason));
    uploadId = begin.uploadId;
    let index = 0;
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES, index += 1) {
      if (cancelled) throw new Error('Загрузка отменена');
      const data = await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
      const r = await request(socket(), 'video:upload:chunk', { uploadId, index, data }, 30000);
      if (!r.ok) throw new Error(reasonText(r.reason));
      uploading.value = { name, percent: Math.round((Math.min(offset + CHUNK_BYTES, file.size) / file.size) * 100) };
    }
    const end = await request(socket(), 'video:upload:end', { uploadId });
    if (!end.ok) throw new Error(reasonText(end.reason));
    uploadId = null;
    toast('Ролик загружен', 'info');
  } catch (err) {
    if (uploadId) socket().emit('video:upload:abort', { uploadId });
    toast(err.message || 'Не удалось загрузить ролик', 'error');
  } finally {
    uploading.value = null;
  }
}
</script>

<template>
  <div class="overlay-body video-body">
    <div v-if="playingId" class="video-now">
      <Icon name="clapperboard" />
      <span class="video-now-name" :title="playingName">Идёт: {{ playingName || 'ролик' }}</span>
      <button class="small danger" @click="stop"><Icon name="square" /> Остановить</button>
    </div>

    <div class="video-list">
      <div v-for="v in store.videos" :key="v.id" class="video-row" :class="{ playing: v.id === playingId }">
        <video class="video-thumb" :src="`/assets/video/${v.file}#t=0.1`" preload="metadata" muted playsinline tabindex="-1"></video>
        <div class="video-meta">
          <span class="video-title" :title="v.label">{{ v.label }}</span>
          <span class="muted small">{{ fmtDuration(v.duration) }} · {{ fmtSize(v.size) }}</span>
        </div>
        <button class="small primary" :data-tip="`Показать всем: ${v.label}`" :aria-label="`Показать ролик ${v.label}`" @click="play(v)"><Icon name="play" /></button>
        <button class="small" data-tip="Удалить" :aria-label="`Удалить ролик ${v.label}`" @click="remove(v)"><Icon name="trash-2" /></button>
      </div>
      <p v-if="!store.videos.length" class="muted small">Роликов пока нет. Загрузите короткий mp4 или webm — его можно будет показать всем одним нажатием.</p>
    </div>

    <div v-if="uploading" class="video-upload">
      <div class="video-upload-row">
        <span class="video-title" :title="uploading.name">{{ uploading.name }}</span>
        <span class="muted small">{{ uploading.percent }}%</span>
        <button class="small" data-tip="Отменить загрузку" aria-label="Отменить загрузку" @click="cancelled = true"><Icon name="x" /></button>
      </div>
      <div class="bar-track"><div class="bar-fill" :style="{ width: `${uploading.percent}%` }"></div></div>
    </div>
    <label v-else class="upload-label">
      <Icon name="upload" /> Загрузить ролик
      <input type="file" accept="video/mp4,video/webm" hidden @change="onFile">
    </label>
    <p class="muted small video-hint">До 25 МБ, mp4 (H.264) или webm. Окно откроется у всех сразу; остановить — «Остановить» здесь или значок в самом окне.</p>
  </div>
</template>
