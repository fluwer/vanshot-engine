<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';

// Панель «Картинки» игрока: свои картинки на карте (те, что ГМ принял после Ctrl+V).
// Владелец сам двигает/масштабирует/вращает их, пока ГМ не заблокировал 🔒, и может
// удалить. Состояние (images/myCharacterId/selectedId/editing) — в store из
// player-panel/main.js (window.imagesPanelApp), его кормит player.js.
const props = defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: true },
});

// Лимит картинок игрока — как MAX_MAP_IMAGES_PER_PLAYER в server/config.js (сервер всё
// равно проверяет; тут только для счётчика).
const MAX_IMAGES = 3;

const root = ref(null);
const mine = computed(() => props.store.images.filter((m) => m.ownerId === props.store.myCharacterId));

function setEditing(on) {
  props.store.editing = on;
  props.bridge.mapController?.setImageEditMode(on);
  // Включили режим — сразу выделяем первую картинку, чтобы была видна рамка с ручками.
  if (on && !props.store.selectedId && mine.value.length) select(mine.value[0].id);
}

function select(id) {
  props.bridge.mapController?.selectMapImage(id);
  props.store.selectedId = id;
}

function center(m) {
  props.bridge.mapController?.centerCameraOn(m.x, m.y);
  select(m.id);
}

function remove(m) {
  if (m.locked) return;
  if (!confirm(`Удалить картинку «${m.name || 'Картинка'}» с карты?`)) return;
  props.bridge.socket.emit('mapimage:remove', { id: m.id }, (res) => {
    if (res && !res.ok) window.imageTools?.notify('Не удалось удалить картинку (её заблокировал ГМ)', 'error');
  });
}

// Esc — выйти из режима правки (клики мимо картинок в этом режиме не двигают фишку).
function onKey(e) {
  if (e.key === 'Escape' && props.store.editing) setEditing(false);
}

// Режим правки не должен «забываться» включённым: закрыли панель (✕ или через ящик
// «Инструменты») — выключаем, иначе клики мимо картинок мешали бы ходу фишки.
let observer = null;
onMounted(() => {
  document.addEventListener('keydown', onKey);
  const panel = root.value && root.value.closest('.draggable-panel');
  if (panel) {
    observer = new MutationObserver(() => {
      if (panel.classList.contains('panel-closed') && props.store.editing) setEditing(false);
    });
    observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  if (observer) observer.disconnect();
});

// Свои картинки закончились (удалили последнюю) — править нечего, режим выключаем.
watch(() => mine.value.length, (n) => {
  if (n === 0 && props.store.editing) setEditing(false);
});
</script>

<template>
  <div class="overlay-body" ref="root">
    <div class="tab-pane tab-pane-flex active">
      <button
        class="fog-btn fog-toggle"
        :class="{ active: store.editing }"
        :disabled="!mine.length"
        @click="setEditing(!store.editing)"
      >✏️ Двигать мои картинки</button>
      <p class="muted small">
        Тяните картинку — переместить, за углы — размер, за верхнюю точку — поворот.
        Пока режим включён, ход фишки приостановлен. Esc — выйти.
      </p>
      <div class="map-images-list">
        <div
          v-for="m in mine"
          :key="m.id"
          class="map-image-row location-row"
          :class="{ selected: m.id === store.selectedId }"
          @click="select(m.id)"
        >
          <span class="location-row-name">{{ m.locked ? '🔒 ' : '' }}{{ m.name || 'Картинка' }}</span>
          <span class="location-row-actions">
            <button class="small" title="Показать на карте" @click.stop="center(m)">🎯</button>
            <button
              class="small danger"
              :disabled="m.locked"
              :title="m.locked ? 'ГМ заблокировал картинку' : 'Удалить картинку'"
              @click.stop="remove(m)"
            >🗑️</button>
          </span>
        </div>
        <p v-if="!mine.length" class="muted small">
          Здесь пока нет ваших картинок. Вставьте картинку через Ctrl+V — ГМ должен её принять.
        </p>
      </div>
      <p class="muted small">Лимит: {{ MAX_IMAGES }} картинки на игрока. 🔒 — ГМ заблокировал правку.</p>
    </div>
  </div>
</template>
