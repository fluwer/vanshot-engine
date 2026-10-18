<script setup>
import { computed, ref } from 'vue';

// Роле-независимая полоса боя («Раунд N · Ход: Имя») сверху по центру — видна ТОЛЬКО
// в бою, клик раскрывает порядок хода. Заменяет пустое окно «Бой» у игрока и
// дополняет блок «Бой» у ГМ (см. .hud-top в gm.html/player.html).
const props = defineProps({
  store: { type: Object, required: true },
});

const expanded = ref(false);

// Те же константы, что в CombatPanel.vue у ГМ — маленькая статичная таблица
// дублируется локально, а не тащится через bridge.
const NPC_FACTIONS = [
  { id: 'enemy', label: 'Враг', icon: '🔴' },
  { id: 'ally', label: 'Союзник', icon: '🟢' },
  { id: 'neutral', label: 'Нейтрал', icon: '⚪' },
];
const NPC_FACTION_BY_ID = Object.fromEntries(NPC_FACTIONS.map((f) => [f.id, f]));

const currentEntry = computed(() => {
  const { order, currentIndex } = props.store.combat;
  return (order && order[currentIndex]) || null;
});

function factionFor(entry) {
  if (entry.type !== 'npc') return null;
  const npc = (props.store.npcs || []).find((n) => n.id === entry.id);
  return npc ? NPC_FACTION_BY_ID[npc.faction || 'neutral'] : null;
}

function turnRowClass(entry, index) {
  const classes = { current: index === props.store.combat.currentIndex };
  const faction = factionFor(entry);
  if (faction) classes[`faction-${faction.id}`] = true;
  return classes;
}
</script>

<template>
  <div v-if="store.combat.active" class="combat-strip">
    <button type="button" class="combat-strip-head" title="Порядок хода" @click="expanded = !expanded">
      <span>⚔ Раунд {{ store.combat.round }}</span>
      <span v-if="currentEntry" class="combat-strip-turn">· Ход: <strong>{{ currentEntry.name }}</strong></span>
      <span class="combat-strip-chevron">{{ expanded ? '▴' : '▾' }}</span>
    </button>
    <div v-if="expanded" class="combat-turn-list combat-strip-list">
      <div
        v-for="(entry, i) in store.combat.order"
        :key="`${entry.type}-${entry.id}`"
        class="combat-turn-row"
        :class="turnRowClass(entry, i)"
      >
        <span>{{ factionFor(entry) ? `${factionFor(entry).icon} ` : '' }}{{ entry.name }}</span>
        <span class="muted small">иниц. {{ entry.initiative }}</span>
      </div>
    </div>
  </div>
</template>
