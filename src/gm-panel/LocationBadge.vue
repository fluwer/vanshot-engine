<script setup>
import Icon from './Icon.vue';
// Роле-независимая строка «Текущая локация» — переиспользуется и в GM-панели,
// и в player-panel (см. main.js обоих бандлов), как DiceLogPanel/ChatPanel.
// У ГМ (clickable) клик открывает пункт «Локации» левой панели.
const props = defineProps({
  store: { type: Object, required: true },
  clickable: { type: Boolean, default: false },
});

function onClick() {
  if (props.clickable) window.Dock?.toggle('locations');
}
</script>

<template>
  <div
    v-if="store.name"
    class="location-badge"
    :class="{ clickable }"
    :title="clickable ? `Текущая локация: ${store.name} — открыть список локаций` : `Текущая локация: ${store.name}`"
    @click="onClick"
  >
    <div class="location-badge-body">
      <span :key="`shine-${store.name}`" class="location-badge-shine" aria-hidden="true"></span>
      <span class="location-badge-icon"><Icon name="map-pin" /></span>
      <span class="location-badge-text">
        <span class="location-badge-label">Локация</span>
        <span :key="store.name" class="location-badge-name">{{ store.name }}</span>
      </span>
    </div>
  </div>
</template>
