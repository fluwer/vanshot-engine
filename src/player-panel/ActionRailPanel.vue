<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: true },
});

const ATTRIBUTE_LABELS = { body: 'Тело', mind: 'Разум', charisma: 'Харизма' };

const character = computed(() => props.store.characters.find((c) => c.id === props.store.myCharacterId));
const spendResolve = ref(false);

function label(key, value) {
  const sign = value >= 0 ? '+' : '';
  return `${ATTRIBUTE_LABELS[key] || key} (${sign}${value})`;
}

function roll(key) {
  if (!character.value) return;
  props.bridge.socket.emit('roll', {
    characterId: character.value.id,
    attribute: key,
    spendResolve: spendResolve.value,
  });
  spendResolve.value = false;
}
</script>

<template>
  <div class="attr-buttons">
    <button v-for="(value, key) in character?.attributes" :key="key" @click="roll(key)">{{ label(key, value) }}</button>
  </div>
  <label class="resolve-toggle"><input type="checkbox" v-model="spendResolve"> −1 Решимость → +2</label>
</template>
