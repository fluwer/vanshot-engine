<script setup>
// bridge передаётся только из gm-panel/main.js — панель общая с игроком
// (player-panel/main.js монтирует её без bridge), поэтому кнопка очистки
// логa через v-if="bridge" автоматически скрыта у игрока.
defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: false, default: null },
});

function formatEntry(entry) {
  return window.formatDiceEntry(entry);
}
</script>

<template>
  <div class="overlay-body log">
    <button v-if="bridge" type="button" class="small log-clear-btn" @click="bridge.socket.emit('dicelog:clear')">Очистить</button>
    <div
      v-for="entry in store.diceLog"
      :key="entry.id"
      class="log-entry"
      :class="{ 'crit-success': entry.critical === 'success', 'crit-fail': entry.critical === 'fail' }"
    >{{ formatEntry(entry) }}</div>
  </div>
</template>
