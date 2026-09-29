<script setup>
import { ref } from 'vue';
import StatRow from './StatRow.vue';
import InventoryEditor from './InventoryEditor.vue';

const props = defineProps({
  character: { type: Object, required: true },
  selected: { type: Boolean, default: false },
  // Раскрыта ли карточка (Эн./Реш./Броня/Урон/Инвентарь) — состояние живёт в
  // родителе (CharactersPanel), а не локально: так родитель может реализовать
  // аккордеон (раскрытие одной карточки схлопывает остальные).
  expanded: { type: Boolean, default: false },
});
const emit = defineEmits([
  'select', 'hp-delta', 'energy-delta', 'resolve-delta', 'armor-delta',
  'item-give', 'item-remove', 'dead-toggle', 'damage-apply', 'info', 'toggle-expand',
]);

const damageAmount = ref('');
function applyDamage() {
  const amount = Number(damageAmount.value);
  if (!Number.isFinite(amount) || amount <= 0) return;
  emit('damage-apply', amount);
  damageAmount.value = '';
}

// Клики по кнопкам/полям/лейблам не должны выбирать персонажа — иначе
// ре-рендер списка сбрасывал бы фокус прямо во время ввода (тот же приём,
// что и в исходном renderCharacters).
function handleCardClick(e) {
  if (e.target.closest('button, input, label')) return;
  emit('select');
}
</script>

<template>
  <div class="card compact char-mini" :class="{ selected }" @click="handleCardClick">
    <div class="row" style="gap:6px">
      <img v-if="character.avatar" class="gm-avatar" :src="character.avatar" alt="">
      <span v-else class="gm-avatar gm-avatar-fallback" :style="{ background: character.color || '#888' }">{{ character.name[0] }}</span>
      <h3 style="margin:0">{{ character.name }} <template v-if="character.claimedBy">({{ character.claimedBy }})</template></h3>
      <button class="small npc-info-toggle" title="Инфо-карточка" @click="emit('info')">ℹ️</button>
      <button class="small" title="Свернуть/развернуть" @click="emit('toggle-expand')">{{ expanded ? '▾' : '▸' }}</button>
    </div>
    <div class="row gm-stat-row">
      <label class="npc-flag-toggle">
        <input type="checkbox" :checked="character.dead" @change="emit('dead-toggle', $event.target.checked)"> ☠ Убит
      </label>
    </div>

    <StatRow label="HP" :current="character.hp.current" :max="character.hp.max" @delta="(d) => emit('hp-delta', d)" />
    <div v-show="expanded">
      <StatRow label="Эн." :current="character.energy.current" :max="character.energy.max" bar-class="energy" @delta="(d) => emit('energy-delta', d)" />
      <StatRow label="Реш." :current="character.resolve.current" :max="character.resolve.max" bar-class="resolve" @delta="(d) => emit('resolve-delta', d)" />
      <StatRow label="Броня" mode="value" :current="character.armor" @delta="(d) => emit('armor-delta', d)" />

      <div class="row gm-stat-row">
        <input class="gm-item-input gm-damage-input" type="number" min="1" placeholder="Урон" v-model="damageAmount">
        <button class="small gm-damage-apply" title="Применить урон" @click="applyDamage">⚔</button>
      </div>

      <InventoryEditor
        :items="character.inventory || []"
        @give="(item) => emit('item-give', item)"
        @remove="(index) => emit('item-remove', index)"
      />
    </div>
  </div>
</template>
