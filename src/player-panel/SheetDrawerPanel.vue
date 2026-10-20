<script setup>
import { computed } from 'vue';
import { useGame } from '../gm-panel/useGame';

const props = defineProps({
  store: { type: Object, required: true },
});

// Подписи ресурсов — из настроек игры; полоски — hp, energy, resolve (класс задаёт цвет), броня — число.
const { res } = useGame();
const BARS = [
  { id: 'hp', cls: '' },
  { id: 'energy', cls: 'energy' },
  { id: 'resolve', cls: 'resolve' },
];

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
    <div v-for="bar in BARS" :key="bar.id" class="row">
      <span class="stat-label">{{ res(bar.id).label }}</span>
      <div class="bar-track"><div class="bar-fill" :class="bar.cls" :style="{ width: `${pct(bar.id)}%` }"></div></div>
      <span>{{ character[bar.id].current }}/{{ character[bar.id].max }}</span>
    </div>
    <div class="row">
      <span class="stat-label">{{ res('armor').label }}</span>
      <span>{{ character.armor }}</span>
    </div>
    <p class="muted small">{{ character.backstory || '' }}</p>
  </template>
</template>
