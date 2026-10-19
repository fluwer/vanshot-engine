<script setup>
import { ref, watch } from 'vue';
import { useDock } from './useDock.js';
import Icon from './Icon.vue';

// Роле-независимая панель — переиспользуется и в GM-панели, и в
// player-panel (см. main.js обоих бандлов), как DiceLogPanel/ChatPanel.
const props = defineProps({
  bridge: { type: Object, required: true },
});

// Эффекты — инструмент левой панели (пункт 'vfx'): «заряд» живёт, только пока блок
// открыт. Закрыли блок или выбрали другой пункт — снимаем, иначе клик по карте
// продолжал бы ставить эффект. Это же снимает прежний скрытый конфликт приоритета
// «эффект / рисование / туман»: открыт всегда один пункт.
const dock = useDock();
watch(() => dock.current.value, (item) => {
  if (item !== 'vfx' && armed.value) {
    armed.value = null;
    props.bridge.mapController?.setVfxPlaceMode(null);
  }
});

const TYPES = [
  { type: 'smoke', label: 'Дым', icon: 'wind' },
  { type: 'fire', label: 'Огонь', icon: 'flame' },
  { type: 'firework', label: 'Фейерверк', icon: 'party-popper' },
  { type: 'explosion', label: 'Взрыв', icon: 'bomb' },
  { type: 'lightning', label: 'Молния', icon: 'zap' },
  { type: 'magic', label: 'Магия', icon: 'wand-sparkles' },
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
    <div class="vfx-grid">
      <button
        v-for="t in TYPES"
        :key="t.type"
        class="fog-btn"
        :class="{ active: armed === t.type }"
        @click="toggle(t.type)"
      ><Icon :name="t.icon" /> {{ t.label }}</button>
    </div>
  </div>
</template>
