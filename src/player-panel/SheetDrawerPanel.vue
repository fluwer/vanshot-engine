<script setup>
import { computed } from 'vue';

const props = defineProps({
  store: { type: Object, required: true },
});

// Заголовок ящика (char-title) зависит от выбранного персонажа, поэтому
// drawer-head тоже переехал сюда целиком (а не остался статичным, как у
// skills-drawer — там в заголовке нет динамического текста). Кнопка закрытия
// (.drawer-close) по-прежнему обрабатывается в player.js, но через делегирование
// на document, а не querySelectorAll в момент загрузки — иначе слушатель не
// повесился бы на кнопку, которую Vue рендерит позже, чем выполняется player.js.
const character = computed(() => props.store.characters.find((c) => c.id === props.store.myCharacterId));

function pct(stat) {
  if (!character.value) return 0;
  const s = character.value[stat];
  return (s.current / s.max) * 100;
}
</script>

<template>
  <div class="drawer-head">
    <h2>{{ character ? `${character.name} — ${character.title}` : '—' }}</h2>
    <button class="drawer-close" data-close="sheet-drawer">✕</button>
  </div>
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
