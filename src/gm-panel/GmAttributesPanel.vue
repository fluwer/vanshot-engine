<script setup>
import { computed } from 'vue';
import Icon from './Icon.vue';
import DamageDice from './DamageDice.vue';
import { useGame } from './useGame';

// Переиспользует тот же store, что и CharactersPanel (characters/npcs/selected) —
// ту же выборку строит sidebar, не нужно тащить отдельную копию через bridge.
const props = defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: true },
});

// Подписи и иконки атрибутов — из настроек игры (те же, что в логе бросков public/js/dice.js).
const { attr } = useGame();

const activeEntity = computed(() => {
  const sel = props.store.selected;
  if (!sel) return null;
  if (sel.type === 'npc') return props.store.npcs.find((n) => n.id === sel.id) || null;
  if (sel.type === 'character') return props.store.characters.find((c) => c.id === sel.id) || null;
  return null;
});

const labelText = computed(() => (
  activeEntity.value ? `Бросок за ${activeEntity.value.name}:` : 'Бросок: выберите фишку на карте'
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
      :title="attr(key).label"
      @click="roll(key)"
    ><Icon :name="attr(key).icon" /> {{ attrSign(value) }}{{ value }}</button>
  </div>
  <!-- Кубик урона: за выбранную фишку, а без выбора — от «Мастера» -->
  <DamageDice :bridge="bridge" :character-id="activeEntity ? activeEntity.id : null" />
</template>
