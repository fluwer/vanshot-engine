<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import Modal from './Modal.vue';

const props = defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: true },
});

const activeTab = ref('tab-fog');

// Взаимоисключение режимов редактирования (туман/картинки/рисование):
// mapController в каждый момент включает только один режим (см. map.js —
// проверка идёт в фиксированном порядке fogEdit > imageEdit > drawMode).
const activeEditMode = ref(null); // null | 'fog' | 'image' | 'draw'
function setEditMode(mode) {
  activeEditMode.value = activeEditMode.value === mode ? null : mode;
  props.bridge.mapController.setFogEditMode(activeEditMode.value === 'fog');
  props.bridge.mapController.setImageEditMode(activeEditMode.value === 'image');
  props.bridge.mapController.setDrawMode(activeEditMode.value === 'draw');
}

// ---- Туман войны ----
const fogTool = ref('brush');
const fogHide = ref(true);
const fogBrush = ref(2);
function setFogTool(tool) {
  fogTool.value = tool;
  props.bridge.mapController.setFogTool(tool);
}
function setFogHide(hide) {
  fogHide.value = hide;
  props.bridge.mapController.setFogHide(hide);
}
function onFogBrushInput() {
  props.bridge.mapController.setFogBrush(Number(fogBrush.value));
}
function hideAllFog() {
  props.bridge.mapController.hideAllFog();
}
function revealAllFog() {
  props.bridge.mapController.revealAllFog();
}

// ---- Картинки на карте ----
const selectedMapImageId = ref(null);
const selectedMapImage = computed(() => props.store.mapImages.find((m) => m.id === selectedMapImageId.value));

function imageLabel(m) {
  // name — исходное имя файла (см. onFileChange); у картинок, загруженных
  // до появления этого поля, его нет — оставляем старый фолбэк по времени.
  const label = m.name || `Картинка ${new Date(Number(m.id.split('-')[0])).toLocaleTimeString()}`;
  // Картинки, принятые от игроков, — с именем владельца (👤): он правит их сам, пока не 🔒.
  const owner = m.ownerName ? `👤 ${m.ownerName}: ` : '';
  return `${m.locked ? '🔒 ' : ''}${owner}${label}`;
}

function selectImage(id) {
  props.bridge.mapController.selectMapImage(id);
  selectedMapImageId.value = id;
  const img = props.store.mapImages.find((m) => m.id === id);
  if (img) props.bridge.mapController.centerCameraOn(img.x, img.y);
}

// Загрузка одного файла-картинки на карту — общий путь для <input type=file> и
// вставки из буфера (Ctrl+V). Кодирование (сжатие, сохранение прозрачности) —
// в public/js/imagetools.js. offsetIndex сдвигает позицию, когда вставлено
// сразу несколько файлов, иначе они легли бы друг на друга в одной точке.
function uploadMapImageFile(file, offsetIndex = 0) {
  return new Promise((resolve) => {
    window.imageTools.encodeFile(file).then(({ dataUrl, w, h }) => {
      // Размещаем картинку по центру текущего вьюпорта ГМ (а не по центру
      // всей карты — почти всегда вне поля зрения), и сразу выделяем её +
      // включаем режим редактирования, чтобы можно было сходу расположить.
      const center = props.bridge.mapController.getCameraCenter();
      const shift = offsetIndex * 40;
      props.bridge.socket.emit(
        'mapimage:upload',
        { dataUrl, naturalWidth: w, naturalHeight: h, name: window.imageTools.imageName(file), x: center.x + shift, y: center.y + shift },
        (ack) => {
          if (ack && ack.ok && ack.entry) {
            selectImage(ack.entry.id);
            // setEditMode — тоггл: если ГМ уже в режиме редактирования,
            // повторный вызов его выключит, поэтому вызываем только когда
            // режим ещё не включён.
            if (activeEditMode.value !== 'image') setEditMode('image');
            activeTab.value = 'tab-images';
          } else {
            window.imageTools.notify('Не удалось загрузить картинку (слишком большая или неподдерживаемый формат)', 'error');
          }
          resolve();
        },
      );
    }).catch((err) => {
      window.imageTools.notify((err && err.message) || 'Не удалось прочитать картинку', 'error');
      resolve();
    });
  });
}

// Пока идёт загрузка, повторный Ctrl+V игнорируется (иначе двойное нажатие
// клало бы дубликаты, а лимита на число картинок на сервере нет).
let uploading = false;
async function uploadFiles(files) {
  if (uploading) return;
  uploading = true;
  try {
    for (let i = 0; i < files.length; i += 1) await uploadMapImageFile(files[i], i);
  } finally {
    uploading = false;
  }
}

function onFileChange(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (file) uploadFiles([file]);
}

// Ctrl+V с картинкой в буфере (скриншот, «Копировать изображение» в браузере)
// кладёт её на карту. Текстовую вставку (чат, поля) не трогаем — см.
// imageTools.shouldIgnorePaste.
function onPaste(e) {
  if (window.imageTools.shouldIgnorePaste(e)) return;
  const files = window.imageTools.clipboardImageFiles(e);
  if (!files.length) return;
  e.preventDefault();
  uploadFiles(files);
}

function onLockChange(e) {
  const id = selectedMapImageId.value;
  if (!id) return;
  props.bridge.socket.emit('mapimage:update', { id, locked: e.target.checked });
}

function removeImage() {
  const id = selectedMapImageId.value;
  if (!id) return;
  props.bridge.socket.emit('mapimage:remove', { id });
}

onMounted(() => {
  // Клик/драг по картинке прямо на канвасе — синхронизируем выделение с панелью.
  props.bridge.mapController.setMapImageSelectHandler(() => {
    selectedMapImageId.value = props.bridge.mapController.getSelectedMapImageId();
  });
  // Панель при сворачивании остаётся смонтированной (прячется CSS-ом), поэтому
  // вставка работает и со свёрнутой панелью.
  document.addEventListener('paste', onPaste);
});
onBeforeUnmount(() => {
  document.removeEventListener('paste', onPaste);
});

// ---- Рисование на карте ----
const drawTool = ref('pen');
const drawWidth = ref(4);
function setDrawTool(tool) {
  drawTool.value = tool;
  props.bridge.mapController.setDrawTool(tool);
}
function onDrawWidthInput() {
  props.bridge.mapController.setDrawWidth(Number(drawWidth.value));
}
function undoDraw() {
  props.bridge.socket.emit('drawing:undo');
}
function clearAllDraw() {
  if (confirm('Удалить рисунки ВСЕХ участников без возможности восстановления?')) {
    props.bridge.socket.emit('drawing:clear');
  }
}

// ---- Локации ----
const showLocationDialog = ref(false);
const newLocationName = ref('');
const renamingLocationId = ref(null);
const renameValue = ref('');

function openLocationDialog() {
  newLocationName.value = '';
  showLocationDialog.value = true;
}

// Выбранная в списке локация — чисто локальное состояние панели (на сервер не
// уходит): клик по строке только выбирает, а переход выполняет отдельная кнопка
// «Перейти на выбранную локацию». Активная локация (📍) и выбранная — разные вещи.
const selectedLocationId = ref(null);
const selectedLocationIndex = computed(() => props.store.locations.findIndex((l) => l.id === selectedLocationId.value));
const canGoToSelected = computed(() =>
  selectedLocationIndex.value !== -1 && selectedLocationId.value !== props.store.activeLocationId);
const canMoveUp = computed(() => selectedLocationIndex.value > 0);
const canMoveDown = computed(() =>
  selectedLocationIndex.value !== -1 && selectedLocationIndex.value < props.store.locations.length - 1);

// Список локаций приходит с каждым state: если выбранной больше нет (удалена)
// или выбора ещё не было — выбираем активную.
watch(() => props.store.locations, () => {
  if (selectedLocationIndex.value === -1) selectedLocationId.value = props.store.activeLocationId;
}, { immediate: true });

// Размер сетки не спрашиваем: карта бесконечная, у локации только «домашняя
// область» по умолчанию (см. server/config.js, server/map.js).
function addLocation() {
  const name = newLocationName.value.trim();
  if (!name) return;
  props.bridge.socket.emit(
    'location:add',
    { name },
    (ack) => {
      if (ack && ack.ok && ack.location) {
        showLocationDialog.value = false;
        // Только выбираем созданную локацию: переход — осознанное действие
        // кнопкой «Перейти», а не побочный эффект создания.
        selectedLocationId.value = ack.location.id;
      }
    },
  );
}

function switchLocation(locationId) {
  if (locationId === props.store.activeLocationId) return;
  props.bridge.socket.emit('location:switch', { locationId });
}

function goToSelectedLocation() {
  if (canGoToSelected.value) switchLocation(selectedLocationId.value);
}

// Порядок локаций = порядок в списке; сдвигаем выбранную на одну позицию.
function moveSelectedLocation(delta) {
  const to = selectedLocationIndex.value + delta;
  if (selectedLocationIndex.value === -1 || to < 0 || to >= props.store.locations.length) return;
  props.bridge.socket.emit('location:move', { locationId: selectedLocationId.value, toIndex: to });
}

function startRename(loc) {
  renamingLocationId.value = loc.id;
  renameValue.value = loc.name;
}
function commitRename() {
  const id = renamingLocationId.value;
  const name = renameValue.value.trim();
  renamingLocationId.value = null;
  if (!id || !name) return;
  props.bridge.socket.emit('location:rename', { locationId: id, name });
}

function removeLocation(locationId) {
  if (!confirm('Удалить локацию без возможности восстановления (её картинки/туман/рисунки исчезнут)?')) return;
  props.bridge.socket.emit('location:remove', { locationId }, (ack) => {
    if (ack && !ack.ok) {
      const reasons = {
        'last-location': 'Нельзя удалить единственную локацию.',
        'active-location': 'Нельзя удалить активную локацию — сначала переключитесь на другую.',
        'has-npcs': 'В локации есть NPC — сначала перенесите их в другую локацию.',
      };
      alert(reasons[ack.reason] || 'Не удалось удалить локацию.');
    }
  });
}
</script>

<template>
  <div class="panel-tabs">
    <button class="panel-tab" :class="{ active: activeTab === 'tab-fog' }" @click="activeTab = 'tab-fog'">🌫️ Туман</button>
    <button class="panel-tab" :class="{ active: activeTab === 'tab-images' }" @click="activeTab = 'tab-images'">🖼️ Картинки</button>
    <button class="panel-tab" :class="{ active: activeTab === 'tab-drawing' }" @click="activeTab = 'tab-drawing'">✏️ Рисование</button>
    <button class="panel-tab" :class="{ active: activeTab === 'tab-locations' }" @click="activeTab = 'tab-locations'">🗺️ Локации</button>
  </div>
  <div class="overlay-body">
    <div class="tab-pane tab-pane-flex" :class="{ active: activeTab === 'tab-fog' }">
      <div class="row" style="align-items:center; gap:4px;">
        <button class="fog-btn fog-toggle" :class="{ active: activeEditMode === 'fog' }" @click="setEditMode('fog')">✏️ Рисовать</button>
        <span class="hint-icon" title="Включите «Рисовать», затем закрашивайте карту. Игроки видят закрашенное чёрным.">❓</span>
      </div>
      <div class="fog-group">
        <div class="row" style="gap:4px">
          <button class="fog-btn fog-tool" :class="{ active: fogTool === 'brush' }" title="Кисть" @click="setFogTool('brush')">🖌️</button>
          <button class="fog-btn fog-tool" :class="{ active: fogTool === 'zone' }" title="Зона" @click="setFogTool('zone')">▭</button>
        </div>
      </div>
      <div class="fog-group">
        <span class="fog-label">Режим</span>
        <div class="row" style="gap:4px">
          <button class="fog-btn fog-mode" :class="{ active: fogHide }" @click="setFogHide(true)">Скрыть</button>
          <button class="fog-btn fog-mode" :class="{ active: !fogHide }" @click="setFogHide(false)">Открыть</button>
        </div>
      </div>
      <div class="fog-group">
        <span class="fog-label">Размер кисти: <span>{{ fogBrush }}</span></span>
        <input type="range" min="0" max="8" v-model="fogBrush" @input="onFogBrushInput">
      </div>
      <div class="row" style="gap:4px">
        <button class="fog-btn" @click="hideAllFog">Скрыть всё</button>
        <button class="fog-btn" @click="revealAllFog">Открыть всё</button>
      </div>
    </div>
    <div class="tab-pane tab-pane-flex" :class="{ active: activeTab === 'tab-images' }">
      <div class="row" style="align-items:center; gap:4px;">
        <button class="fog-btn fog-toggle" :class="{ active: activeEditMode === 'image' }" @click="setEditMode('image')">✏️ Редактировать</button>
        <span class="hint-icon" title="Включите «Редактировать», перетаскивайте картинку по карте, тяните за угловые точки для масштабирования, за верхнюю ручку — для поворота.">❓</span>
      </div>
      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" @change="onFileChange">
      <p class="muted small">Ctrl+V — вставить картинку из буфера (скриншот или «Копировать изображение»). Игроки тоже могут вставлять — вы увидите запрос на согласование.</p>
      <div class="map-images-list">
        <div
          v-for="m in store.mapImages"
          :key="m.id"
          class="map-image-row"
          :class="{ selected: m.id === selectedMapImageId }"
          @click="selectImage(m.id)"
        ><span>{{ imageLabel(m) }}</span></div>
        <p v-if="!store.mapImages.length" class="muted small">Пока нет картинок</p>
      </div>
      <div class="map-image-controls" v-show="selectedMapImage">
        <label class="npc-flag-toggle"><input type="checkbox" :checked="selectedMapImage?.locked" @change="onLockChange"> <span title="Заблокировать позицию (запретить перемещение). У картинки игрока блокировка запрещает правку и удаление и владельцу.">🔒</span></label>
        <button class="small danger wide" @click="removeImage">Удалить картинку</button>
      </div>
    </div>
    <div class="tab-pane tab-pane-flex" :class="{ active: activeTab === 'tab-drawing' }">
      <button class="fog-btn fog-toggle" :class="{ active: activeEditMode === 'draw' }" @click="setEditMode('draw')">✏️ Рисовать</button>
      <div class="fog-group">
        <div class="row" style="gap:4px">
          <button class="fog-btn draw-tool" :class="{ active: drawTool === 'pen' }" title="Перо" aria-label="Перо" @click="setDrawTool('pen')">🖊️</button>
          <button class="fog-btn draw-tool" :class="{ active: drawTool === 'eraser' }" title="Ластик — стирает только ваши линии" aria-label="Ластик" @click="setDrawTool('eraser')">🧹</button>
        </div>
      </div>
      <div class="fog-group">
        <span class="fog-label">Толщина: <span>{{ drawWidth }}</span></span>
        <input type="range" min="1" max="16" v-model="drawWidth" @input="onDrawWidthInput">
      </div>
      <button class="fog-btn wide" @click="undoDraw">↩ Отменить моё действие</button>
      <button class="fog-btn danger wide" @click="clearAllDraw">Очистить всё (у всех)</button>
    </div>
    <div class="tab-pane tab-pane-flex" :class="{ active: activeTab === 'tab-locations' }">
      <div class="map-images-list">
        <div
          v-for="(loc, i) in store.locations"
          :key="loc.id"
          class="map-image-row location-row"
          :class="{ selected: loc.id === selectedLocationId, 'active-location': loc.id === store.activeLocationId }"
          @click="selectedLocationId = loc.id"
        >
          <span class="location-index">{{ i + 1 }}.</span>
          <input
            v-if="renamingLocationId === loc.id"
            class="gm-item-input location-row-name"
            v-model="renameValue"
            @keyup.enter="commitRename"
            @blur="commitRename"
            @click.stop
            autofocus
          >
          <template v-else>
            <span class="location-row-name">{{ loc.id === store.activeLocationId ? '📍 ' : '' }}{{ loc.name }}</span>
            <span class="location-row-actions">
              <button class="small" title="Переименовать" @click.stop="startRename(loc)">✏️</button>
              <button
                v-if="loc.id !== store.activeLocationId"
                class="small danger"
                title="Удалить локацию"
                @click.stop="removeLocation(loc.id)"
              >🗑️</button>
            </span>
          </template>
        </div>
        <p v-if="!store.locations.length" class="muted small">Нет локаций</p>
      </div>
      <div class="row" style="gap:4px">
        <button class="fog-btn" title="Выбранную локацию выше в списке" :disabled="!canMoveUp" @click="moveSelectedLocation(-1)">▲</button>
        <button class="fog-btn" title="Выбранную локацию ниже в списке" :disabled="!canMoveDown" @click="moveSelectedLocation(1)">▼</button>
      </div>
      <button class="fog-btn fog-toggle" :disabled="!canGoToSelected" @click="goToSelectedLocation">➡️ Перейти на выбранную локацию</button>
      <button class="fog-btn wide" @click="openLocationDialog">➕ Создать локацию</button>
    </div>
  </div>
  <Modal v-if="showLocationDialog" @close="showLocationDialog = false">
    <template #title>Новая локация</template>
    <div class="form-field">
      <span class="form-field-label">Название</span>
      <input v-model="newLocationName" placeholder="Название" @keyup.enter="addLocation" autofocus>
    </div>
    <div class="form-actions">
      <button @click="addLocation">Создать</button>
      <button @click="showLocationDialog = false">Отмена</button>
    </div>
  </Modal>
</template>
