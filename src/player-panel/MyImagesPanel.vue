<script setup>
import { computed, watch } from 'vue';
import { useDock } from '../gm-panel/useDock.js';
import Icon from '../gm-panel/Icon.vue';
import ImageLayerTools from '../gm-panel/ImageLayerTools.vue';

// Блок «Картинки» игрока: свои картинки на карте (те, что ГМ принял после Ctrl+V).
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

const mine = computed(() => props.store.images.filter((m) => m.ownerId === props.store.myCharacterId));
const selectedImage = computed(() => mine.value.find((m) => m.id === props.store.selectedId) || null);

// Режим правки = блок «Картинки» открыт (пункт 'images' левой панели) И есть что
// править. Закрыли блок (повторный клик, ✕, Esc) — режим выключается сам, и тап по
// клетке снова двигает фишку; без своих картинок включать нечего (иначе клики по
// карте молча не двигали бы фишку).
const dock = useDock();
const editing = computed(() => dock.current.value === 'images' && mine.value.length > 0);
watch(editing, (on) => {
  props.store.editing = on;
  props.bridge.mapController?.setImageEditMode(on);
  // Включили режим — сразу выделяем первую картинку, чтобы была видна рамка с ручками.
  if (on && !props.store.selectedId && mine.value.length) select(mine.value[0].id);
});

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
</script>

<template>
  <div class="overlay-body">
    <div class="tab-pane tab-pane-flex active">
      <p class="muted small">
        Пока блок открыт, картинки можно править: тяните картинку — переместить, за углы — размер,
        за верхнюю точку — поворот. Ход фишки в это время приостановлен — закройте блок (Esc), чтобы ходить.
      </p>
      <div class="map-images-list">
        <div
          v-for="m in mine"
          :key="m.id"
          class="map-image-row location-row"
          :class="{ selected: m.id === store.selectedId }"
          @click="select(m.id)"
        >
          <span class="location-row-name"><Icon v-if="m.locked" name="lock" /> {{ m.name || 'Картинка' }}</span>
          <span class="location-row-actions">
            <button class="small" title="Показать на карте" aria-label="Показать на карте" @click.stop="center(m)"><Icon name="crosshair" /></button>
            <button
              class="small danger"
              :disabled="m.locked"
              :title="m.locked ? 'ГМ заблокировал картинку' : 'Удалить картинку'"
              @click.stop="remove(m)"
            ><Icon name="trash-2" /></button>
          </span>
        </div>
        <p v-if="!mine.length" class="muted small">
          Здесь пока нет ваших картинок. Вставьте картинку через Ctrl+V — ГМ должен её принять.
        </p>
      </div>
      <ImageLayerTools v-if="selectedImage" :image="selectedImage" :stack="store.images" :bridge="bridge" />
      <p class="muted small">Лимит: {{ MAX_IMAGES }} картинки на игрока. <Icon name="lock" /> — ГМ заблокировал правку.</p>
    </div>
  </div>
</template>
