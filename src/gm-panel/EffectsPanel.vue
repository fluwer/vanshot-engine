<script setup>
import { ref } from 'vue';

// Роле-независимая панель — переиспользуется и в GM-панели, и в
// player-panel (см. main.js обоих бандлов), как DiceLogPanel/ChatPanel.
const props = defineProps({
  bridge: { type: Object, required: true },
});

const TYPES = [
  { type: 'smoke', label: '💨 Дым' },
  { type: 'fire', label: '🔥 Огонь' },
  { type: 'firework', label: '🎆 Фейерверк' },
];

// Режим "заряжен" — не гасится после одного клика по карте (можно ставить
// эффекты подряд), выключается повторным нажатием той же кнопки. См.
// mapController.setVfxPlaceMode в public/js/map.js.
const armed = ref(null);

function toggle(type) {
  armed.value = armed.value === type ? null : type;
  props.bridge.mapController?.setVfxPlaceMode(armed.value);
}
</script>

<template>
  <div class="overlay-body">
    <p class="muted small">Выберите эффект, затем кликните по карте — можно ставить несколько подряд.</p>
    <div class="row" style="gap:4px">
      <button
        v-for="t in TYPES"
        :key="t.type"
        class="fog-btn"
        :class="{ active: armed === t.type }"
        @click="toggle(t.type)"
      >{{ t.label }}</button>
    </div>
  </div>
</template>
