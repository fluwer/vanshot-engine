<script setup>
import { ref, computed, onMounted } from 'vue';
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
  return `${m.locked ? '🔒 ' : ''}${label}`;
}

function selectImage(id) {
  props.bridge.mapController.selectMapImage(id);
  selectedMapImageId.value = id;
  const img = props.store.mapImages.find((m) => m.id === id);
  if (img) props.bridge.mapController.centerCameraOn(img.x, img.y);
}

function onFileChange(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  e.target.value = '';
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const maxSize = 1600;
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      // Размещаем картинку по центру текущего вьюпорта ГМ (а не по центру
      // всей карты — почти всегда вне поля зрения), и сразу выделяем её +
      // включаем режим редактирования, чтобы можно было сходу расположить.
      const center = props.bridge.mapController.getCameraCenter();
      props.bridge.socket.emit(
        'mapimage:upload',
        { dataUrl, naturalWidth: w, naturalHeight: h, name: file.name, x: center.x, y: center.y },
        (ack) => {
          if (ack && ack.ok && ack.entry) {
            selectImage(ack.entry.id);
            // setEditMode — тоггл: если ГМ уже в режиме редактирования,
            // повторный вызов его выключит, поэтому вызываем только когда
            // режим ещё не включён.
            if (activeEditMode.value !== 'image') setEditMode('image');
          }
        },
      );
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
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
const newLocationWidth = ref(60);
const newLocationHeight = ref(40);
const renamingLocationId = ref(null);
const renameValue = ref('');

function openLocationDialog() {
  newLocationName.value = '';
  newLocationWidth.value = 60;
  newLocationHeight.value = 40;
  showLocationDialog.value = true;
}

function addLocation() {
  const name = newLocationName.value.trim();
  if (!name) return;
  props.bridge.socket.emit(
    'location:add',
    { name, gridWidth: Number(newLocationWidth.value), gridHeight: Number(newLocationHeight.value) },
    (ack) => {
      if (ack && ack.ok && ack.location) {
        showLocationDialog.value = false;
        // Сразу открываем созданную локацию — иначе ГМ остаётся в старой и
        // должен вручную кликать по новой строке в списке.
        switchLocation(ack.location.id);
      }
    },
  );
}

function switchLocation(locationId) {
  if (locationId === props.store.activeLocationId) return;
  props.bridge.socket.emit('location:switch', { locationId });
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
        <label class="npc-flag-toggle"><input type="checkbox" :checked="selectedMapImage?.locked" @change="onLockChange"> <span title="Заблокировать позицию (запретить перемещение)">🔒</span></label>
        <button class="small danger wide" @click="removeImage">Удалить картинку</button>
      </div>
    </div>
    <div class="tab-pane tab-pane-flex" :class="{ active: activeTab === 'tab-drawing' }">
      <div class="row" style="align-items:center; gap:4px;">
        <button class="fog-btn fog-toggle" :class="{ active: activeEditMode === 'draw' }" @click="setEditMode('draw')">✏️ Рисовать</button>
        <span class="hint-icon" title="Включите «Рисовать», ведите мышью/пальцем по карте. Ластик стирает только ваши линии; «Очистить всё» удаляет рисунки всех участников без возможности восстановления.">❓</span>
      </div>
      <div class="fog-group">
        <div class="row" style="gap:4px">
          <button class="fog-btn draw-tool" :class="{ active: drawTool === 'pen' }" title="Перо" @click="setDrawTool('pen')">🖊️</button>
          <button class="fog-btn draw-tool" :class="{ active: drawTool === 'eraser' }" title="Ластик" @click="setDrawTool('eraser')">🧹</button>
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
          v-for="loc in store.locations"
          :key="loc.id"
          class="map-image-row location-row"
          :class="{ selected: loc.id === store.activeLocationId }"
          @click="switchLocation(loc.id)"
        >
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
      <button class="fog-btn wide" @click="openLocationDialog">➕ Создать локацию</button>
    </div>
  </div>
  <Modal v-if="showLocationDialog" @close="showLocationDialog = false">
    <template #title>Новая локация</template>
    <div class="form-field">
      <span class="form-field-label">Название</span>
      <input v-model="newLocationName" placeholder="Название" @keyup.enter="addLocation" autofocus>
    </div>
    <div class="form-row">
      <div class="form-field form-subfield">
        <span class="form-subfield-label">Ширина</span>
        <input type="number" min="5" max="300" v-model="newLocationWidth">
      </div>
      <div class="form-field form-subfield">
        <span class="form-subfield-label">Высота</span>
        <input type="number" min="5" max="300" v-model="newLocationHeight">
      </div>
    </div>
    <div class="form-actions">
      <button @click="addLocation">Создать</button>
      <button @click="showLocationDialog = false">Отмена</button>
    </div>
  </Modal>
</template>
