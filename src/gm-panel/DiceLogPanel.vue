<script setup>
defineProps({
  store: { type: Object, required: true },
});

function formatEntry(entry) {
  return window.formatDiceEntry(entry);
}
</script>

<template>
  <div class="overlay-body log">
    <div
      v-for="entry in store.diceLog"
      :key="entry.id"
      class="log-entry"
      :class="{ 'crit-success': entry.critical === 'success', 'crit-fail': entry.critical === 'fail' }"
    >{{ formatEntry(entry) }}</div>
  </div>
</template>
