<script setup>
import { computed } from 'vue';

// Переиспользует тот же store, что и CharactersPanel (characters/npcs/selected) —
// ту же выборку строит sidebar, не нужно тащить отдельную копию через bridge.
const props = defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: true },
});

const ATTRIBUTE_LABELS = { body: 'Тело', mind: 'Разум', charisma: 'Харизма' };
// Те же иконки, что и в public/js/dice.js (ATTR_ICONS) — переиспользуем,
// чтобы не заводить второй набор эмодзи для одних и тех же атрибутов.
const ATTRIBUTE_ICONS = { body: '💪', mind: '🧠', charisma: '💬' };

const activeEntity = computed(() => {
  const sel = props.store.selected;
  if (!sel) return null;
  if (sel.type === 'npc') return props.store.npcs.find((n) => n.id === sel.id) || null;
  if (sel.type === 'character') return props.store.characters.find((c) => c.id === sel.id) || null;
  return null;
});

const labelText = computed(() => (
  activeEntity.value ? `Бросок за ${activeEntity.value.name}:` : 'Бросок за персонажа: выберите на карте'
));

function attrSign(value) {
  return value >= 0 ? '+' : '';
}

function roll(key) {
  props.bridge.socket.emit('roll', { characterId: activeEntity.value.id, attribute: key, spendResolve: false });
}
</script>

<template>
  <span class="muted small">{{ labelText }}</span>
  <div class="attr-buttons">
    <button
      v-for="(value, key) in activeEntity?.attributes"
      :key="key"
      class="small"
      :title="ATTRIBUTE_LABELS[key] || key"
      @click="roll(key)"
    >{{ ATTRIBUTE_ICONS[key] || '🔹' }} {{ attrSign(value) }}{{ value }}</button>
  </div>
</template>
