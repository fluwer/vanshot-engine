<script setup>
import { computed } from 'vue';

const props = defineProps({
  store: { type: Object, required: true },
});

// Лист персонажа — верхняя часть блока «Персонаж» (ниже — навыки и инвентарь,
// SkillsInventoryPanel). Шапку с заголовком блока и ✕ даёт Dock, здесь — только
// имя/титул персонажа, поэтому он зависит от выбранного героя.
const character = computed(() => props.store.characters.find((c) => c.id === props.store.myCharacterId));

function pct(stat) {
  if (!character.value) return 0;
  const s = character.value[stat];
  return (s.current / s.max) * 100;
}
</script>

<template>
  <h2>{{ character ? `${character.name} — ${character.title}` : '—' }}</h2>
  <template v-if="character">
    <p class="muted">{{ character.hook }}</p>
    <div class="row">
      <span class="stat-label">HP</span>
      <div class="bar-track"><div class="bar-fill" :style="{ width: `${pct('hp')}%` }"></div></div>
      <span>{{ character.hp.current }}/{{ character.hp.max }}</span>
    </div>
    <div class="row">
      <span class="stat-label">Энергия</span>
      <div class="bar-track"><div class="bar-fill energy" :style="{ width: `${pct('energy')}%` }"></div></div>
      <span>{{ character.energy.current }}/{{ character.energy.max }}</span>
    </div>
    <div class="row">
      <span class="stat-label">Решимость</span>
      <div class="bar-track"><div class="bar-fill resolve" :style="{ width: `${pct('resolve')}%` }"></div></div>
      <span>{{ character.resolve.current }}/{{ character.resolve.max }}</span>
    </div>
    <div class="row">
      <span class="stat-label">Броня</span>
      <span>{{ character.armor }}</span>
    </div>
    <p class="muted small">{{ character.backstory || '' }}</p>
  </template>
</template>
