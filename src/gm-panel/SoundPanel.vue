<script setup>
import { ref, onMounted, watch } from 'vue';

const props = defineProps({
  bridge: { type: Object, required: true },
});

const activeTab = ref('soundboard');

// Кнопки удаления звука/трека по умолчанию скрыты — иначе во время игры
// случайный клик по саундборду вместо проигрывания звука может его удалить.
// Показываются только пока явно включён режим редактирования.
const editMode = ref(false);
let soundboardApi = null;

// soundboard.js/music.js — «чёрный ящик»: кэшируют document.getElementById(...)
// один раз при init*() и дальше правят DOM напрямую. Поэтому вкладки здесь
// переключаются классом (обе панели всегда смонтированы), а не v-if — иначе
// их DOM-ссылки протухнут при пересоздании элементов.
onMounted(() => {
  soundboardApi = window.initSoundboard(props.bridge.socket, 'soundboard-list', { canManage: editMode.value });
  window.initMusicPlayer(props.bridge.socket, {
    role: 'gm',
    selectId: 'music-track-select',
    playId: 'music-play',
    pauseId: 'music-pause',
    stopId: 'music-stop',
    deleteId: 'music-delete',
    nowPlayingId: 'music-now-playing',
    volumeId: 'music-volume',
    volumeValueId: 'music-volume-value',
  });
});

watch(editMode, (value) => soundboardApi?.setManage(value));

// Читаем файл как есть, без канвас-ресайза (это аудио, не картинка) — тот же
// принцип FileReader.readAsDataURL, что и у аватаров/картинок карты.
function readAsDataUrl(file, cb) {
  const reader = new FileReader();
  reader.onload = () => cb(reader.result);
  reader.readAsDataURL(file);
}

// Название звука/трека — то же, что в исходнике: имя файла без расширения,
// без отдельного поля ввода (пользователь и так называет файл заранее).
function baseName(fileName) {
  return fileName.replace(/\.[^./\\]+$/, '');
}

function onSoundFileChange(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  readAsDataUrl(file, (dataUrl) => {
    props.bridge.socket.emit('sound:upload', { name: baseName(file.name), dataUrl }, (ack) => {
      if (!ack || !ack.ok) {
        alert('Не удалось загрузить звук: проверьте формат (mp3/wav/ogg) и размер файла');
      }
    });
  });
  e.target.value = '';
}

function onMusicFileChange(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  readAsDataUrl(file, (dataUrl) => {
    props.bridge.socket.emit('music:upload', { name: baseName(file.name), dataUrl }, (ack) => {
      if (!ack || !ack.ok) {
        alert('Не удалось загрузить трек: проверьте формат (mp3/wav/ogg) и размер файла');
      }
    });
  });
  e.target.value = '';
}
</script>

<template>
  <div class="panel-tabs">
    <button class="panel-tab" :class="{ active: activeTab === 'soundboard' }" @click="activeTab = 'soundboard'">🔊 Саундборд</button>
    <button class="panel-tab" :class="{ active: activeTab === 'music' }" @click="activeTab = 'music'">🎵 Музыка</button>
  </div>
  <div class="row sound-panel-toolbar" style="justify-content:flex-end; padding: 4px 8px; box-sizing:border-box;">
    <button
      class="small"
      :class="{ danger: editMode }"
      :title="editMode ? 'Выключить — скрыть кнопки удаления' : 'Включить — показать кнопки удаления звуков/трека'"
      @click="editMode = !editMode"
    >{{ editMode ? '✓ Готово' : '✎ Редактировать' }}</button>
  </div>
  <div class="overlay-body">
    <div class="tab-pane tab-pane-flex soundboard-list" :class="{ active: activeTab === 'soundboard' }">
      <div id="soundboard-list" class="soundboard-list"></div>
      <label class="upload-label" v-show="editMode">
        Загрузить звук
        <input type="file" accept="audio/*" hidden @change="onSoundFileChange">
      </label>
    </div>
    <div class="tab-pane tab-pane-flex" :class="{ active: activeTab === 'music' }">
      <div class="fog-group">
        <span class="fog-label">Трек</span>
        <select id="music-track-select"></select>
      </div>
      <div class="row" style="gap:4px">
        <button id="music-play" class="fog-btn" title="Играть">▶</button>
        <button id="music-pause" class="fog-btn" title="Пауза">⏸</button>
        <button id="music-stop" class="fog-btn" title="Стоп">⏹</button>
        <button id="music-delete" class="fog-btn danger" v-show="editMode" title="Удалить трек">✕</button>
      </div>
      <p class="muted small" id="music-now-playing">Тишина</p>
      <div class="fog-group">
        <span class="fog-label" title="Громкость слышна только вам">🔊 <span id="music-volume-value">50</span>%</span>
        <input id="music-volume" type="range" min="0" max="100" value="50">
      </div>
      <label class="upload-label" v-show="editMode">
        Загрузить трек
        <input type="file" accept="audio/*" hidden @change="onMusicFileChange">
      </label>
    </div>
  </div>
</template>
