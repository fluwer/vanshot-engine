<script setup>
import { ref } from 'vue';

const props = defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: true },
});

const DC_PRESETS = [
  { label: 'Лёгкий 10', value: 10 },
  { label: 'Средний 14', value: 14 },
  { label: 'Сложный 18', value: 18 },
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
  <div class="row" style="gap:6px; flex-wrap: nowrap;">
    <strong>DC:</strong>
    <div class="row" style="gap:4px">
      <button
        v-for="p in DC_PRESETS"
        :key="p.value"
        class="small"
        :class="{ active: store.currentDc === p.value }"
        @click="setDc(p.value)"
      >{{ p.label }}</button>
    </div>
    <input type="number" placeholder="своё" style="width:64px" v-model="customDc" @change="onCustomChange">
    <button class="small" @click="clearDc">сброс</button>
    <button @click="freeRoll" title="Бросок мастера (d20)">🎲</button>
    <button @click="restoreParty" title="Восстановить энергию и решимость всем">🔄</button>
  </div>
</template>
