<script setup>
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import { useGame } from './useGame';

const props = defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: true },
});

// Правая половина нижней панели ГМ: DC проверки, бросок мастера, восстановление
// отряда. Левая половина — бросок за выбранного (GmAttributesPanel.vue).
// Пресеты DC, кубик проверок и подписи ресурсов — из настроек игры (check, resources).
const { check, res } = useGame();
const DC_PRESETS = computed(() => (check.value.dcPresets || []).map((p) => ({ title: p.label, value: p.value })));
const dieName = computed(() => `d${check.value.die || 20}`);
const restoreTitle = computed(() => `Восстановить ${res('energy').label.toLowerCase()} и ${res('resolve').label.toLowerCase()} всем`);

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
  <button class="small" title="Сбросить DC" aria-label="Сбросить DC" @click="clearDc"><Icon name="x" /></button>
  <button @click="freeRoll" :title="`Бросок мастера (${dieName})`" :aria-label="`Бросок мастера (${dieName})`"><Icon name="d20" /></button>
  <button @click="restoreParty" :title="restoreTitle" :aria-label="restoreTitle"><Icon name="refresh-cw" /></button>
</template>
