<script setup>
import { ref } from 'vue';

const props = defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: true },
});

// Правая половина нижней панели ГМ: DC проверки, бросок мастера, восстановление
// отряда. Левая половина — бросок за выбранного (GmAttributesPanel.vue).
const DC_PRESETS = [
  { title: 'Лёгкий', value: 10 },
  { title: 'Средний', value: 14 },
  { title: 'Сложный', value: 18 },
];

const customDc = ref('');

function setDc(value) {
  props.bridge.socket.emit('dc:set', { dc: value });
}

function onCustomChange() {
  const value = Number(customDc.value);
  if (Number.isFinite(value) && value > 0) props.bridge.socket.emit('dc:set', { dc: value });
}

function clearDc() {
  customDc.value = '';
  props.bridge.socket.emit('dc:set', { dc: 0 });
}

function freeRoll() {
  props.bridge.socket.emit('roll', { characterId: null, attribute: null, spendResolve: false, label: 'Мастер' });
}

function restoreParty() {
  props.bridge.socket.emit('party:restore');
}
</script>

<template>
  <strong title="Сложность проверки (DC)">DC</strong>
  <div class="row" style="gap:4px; flex-wrap: nowrap;">
    <button
      v-for="p in DC_PRESETS"
      :key="p.value"
      class="small"
      :class="{ active: store.currentDc === p.value }"
      :title="`${p.title} — DC ${p.value}`"
      @click="setDc(p.value)"
    >{{ p.value }}</button>
  </div>
  <input type="number" placeholder="своё" title="Своё значение DC" style="width:60px" v-model="customDc" @change="onCustomChange">
  <button class="small" title="Сбросить DC" @click="clearDc">✕</button>
  <button @click="freeRoll" title="Бросок мастера (d20)">🎲</button>
  <button @click="restoreParty" title="Восстановить энергию и решимость всем">🔄</button>
</template>
