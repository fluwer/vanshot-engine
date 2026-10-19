<script setup>
import Icon from './Icon.vue';

// bridge передаётся только из gm-panel/main.js — панель общая с игроком
// (player-panel/main.js монтирует её без bridge), поэтому кнопка очистки
// логa через v-if="bridge" автоматически скрыта у игрока.
defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: false, default: null },
});

// Строка броска — части { text } | { icon, cls } (public/js/dice.js, diceEntryParts):
// иконки вместо эмодзи, текст — только через интерполяцию (имена вводят люди).
function parts(entry) {
  return window.diceEntryParts(entry);
}
</script>

<template>
  <div class="overlay-body log">
    <button v-if="bridge" type="button" class="small log-clear-btn" @click="bridge.socket.emit('dicelog:clear')"><Icon name="trash-2" /> Очистить</button>
    <div
      v-for="entry in store.diceLog"
      :key="entry.id"
      class="log-entry"
      :class="{ 'crit-success': entry.critical === 'success', 'crit-fail': entry.critical === 'fail' }"
    ><template v-for="(p, i) in parts(entry)" :key="i"><Icon v-if="p.icon" :name="p.icon" :class="p.cls" /><template v-else>{{ p.text }}</template></template></div>
  </div>
</template>
