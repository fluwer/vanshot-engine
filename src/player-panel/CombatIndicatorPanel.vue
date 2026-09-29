<script setup>
defineProps({
  store: { type: Object, required: true },
});

// Тот же приём, что в CombatPanel.vue у ГМ — маленькая статичная константа
// дублируется локально, а не тащится через bridge.
const NPC_FACTIONS = [
  { id: 'enemy', label: 'Враг', icon: '🔴' },
  { id: 'ally', label: 'Союзник', icon: '🟢' },
  { id: 'neutral', label: 'Нейтрал', icon: '⚪' },
];
const NPC_FACTION_BY_ID = Object.fromEntries(NPC_FACTIONS.map((f) => [f.id, f]));

function factionFor(entry, npcs) {
  if (entry.type !== 'npc') return null;
  const npc = npcs.find((n) => n.id === entry.id);
  return npc ? NPC_FACTION_BY_ID[npc.faction || 'neutral'] : null;
}

function turnRowClass(entry, index, combat, npcs) {
  const classes = { current: index === combat.currentIndex };
  const faction = factionFor(entry, npcs);
  if (faction) classes[`faction-${faction.id}`] = true;
  return classes;
}
</script>

<template>
  <div class="overlay-body">
    <div v-if="!store.combat.active" class="muted small">Не в бою</div>
    <template v-else>
      <strong>Раунд {{ store.combat.round }}</strong>
      <div class="combat-turn-list">
        <div
          v-for="(entry, i) in store.combat.order"
          :key="`${entry.type}-${entry.id}`"
          class="combat-turn-row"
          :class="turnRowClass(entry, i, store.combat, store.npcs)"
        >
          <span>{{ factionFor(entry, store.npcs) ? `${factionFor(entry, store.npcs).icon} ` : '' }}{{ entry.name }}</span>
          <span class="muted small">иниц. {{ entry.initiative }}</span>
        </div>
      </div>
    </template>
  </div>
</template>
