<script setup>
// Роле-независимая строка «Текущая локация» — переиспользуется и в GM-панели,
// и в player-panel (см. main.js обоих бандлов), как DiceLogPanel/ChatPanel.
defineProps({
  store: { type: Object, required: true },
});
</script>

<template>
  <div v-if="store.name" class="location-badge" :title="`Текущая локация: ${store.name}`">📍 {{ store.name }}</div>
</template>
