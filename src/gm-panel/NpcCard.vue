<script setup>
import { ref } from 'vue';
import StatRow from './StatRow.vue';
import InventoryEditor from './InventoryEditor.vue';

const props = defineProps({
  npc: { type: Object, required: true },
  selected: { type: Boolean, default: false },
  npcColor: { type: String, default: '#c05656' },
  // См. CharacterCard.vue — состояние раскрытия живёт в родителе (аккордеон).
  expanded: { type: Boolean, default: false },
  // Полный список локаций — для селекта переноса NPC (см. TODO.md «Локации»).
  locations: { type: Array, default: () => [] },
});
const emit = defineEmits([
  'select', 'hp-delta', 'energy-delta', 'armor-delta', 'damage-apply',
  'item-give', 'item-remove', 'visible-toggle', 'dead-toggle', 'faction-set', 'info', 'toggle-expand',
  'location-set',
]);

const NPC_FACTIONS = [
  { id: 'enemy', label: 'Враг', icon: '🔴' },
  { id: 'ally', label: 'Союзник', icon: '🟢' },
  { id: 'neutral', label: 'Нейтрал', icon: '⚪' },
];

const damageAmount = ref('');

function applyDamage() {
  const amount = Number(damageAmount.value);
  if (!Number.isFinite(amount) || amount <= 0) return;
  emit('damage-apply', amount);
  damageAmount.value = '';
}

// Клики по кнопкам/полям/лейблам не должны выбирать NPC.
function handleCardClick(e) {
  if (e.target.closest('button, input, label')) return;
  emit('select');
}
</script>

<template>
  <div class="card compact npc-mini" :class="{ selected }" @click="handleCardClick">
    <div class="row" style="gap:6px">
      <img v-if="npc.avatar" class="gm-avatar" :src="npc.avatar" alt="">
      <span v-else class="gm-avatar gm-avatar-fallback" :style="{ background: npcColor }">{{ npc.name[0] }}</span>
      <h3 style="margin:0">{{ npc.name }} ({{ npc.role }})</h3>
      <button class="small npc-info-toggle" title="Инфо-карточка" @click="emit('info')">ℹ️</button>
      <button class="small" title="Свернуть/развернуть" @click="emit('toggle-expand')">{{ expanded ? '▾' : '▸' }}</button>
    </div>

    <div class="row gm-stat-row" style="gap:10px">
      <label class="npc-flag-toggle">
        <input type="checkbox" :checked="npc.visible" @change="emit('visible-toggle', $event.target.checked)"> Виден игрокам
      </label>
      <label class="npc-flag-toggle">
        <input type="checkbox" :checked="npc.dead" @change="emit('dead-toggle', $event.target.checked)"> ☠ Убит
      </label>
    </div>

    <div class="row" style="gap:4px">
      <button
        v-for="f in NPC_FACTIONS"
        :key="f.id"
        class="fog-btn npc-faction-btn"
        :class="{ active: (npc.faction || 'neutral') === f.id }"
        :title="f.label"
        @click="emit('faction-set', f.id)"
      >{{ f.icon }}</button>
    </div>

    <div v-if="locations.length > 1" class="row gm-stat-row" style="gap:6px">
      <label class="npc-flag-toggle">Локация:
        <select class="fog-btn" :value="npc.locationId" @change="emit('location-set', $event.target.value)" @click.stop>
          <option v-for="loc in locations" :key="loc.id" :value="loc.id">{{ loc.name }}</option>
        </select>
      </label>
    </div>

    <StatRow label="HP" :current="npc.hp.current" :max="npc.hp.max" bar-class="npc" @delta="(d) => emit('hp-delta', d)" />
    <div v-show="expanded">
      <StatRow label="Эн." :current="npc.energy.current" :max="npc.energy.max" bar-class="energy" @delta="(d) => emit('energy-delta', d)" />
      <StatRow label="Броня" mode="value" :current="npc.armor" @delta="(d) => emit('armor-delta', d)" />

      <div class="row gm-stat-row">
        <input class="gm-item-input gm-damage-input" type="number" min="1" placeholder="Урон" v-model="damageAmount">
        <button class="small gm-damage-apply" title="Применить урон" @click="applyDamage">⚔</button>
      </div>

      <InventoryEditor
        :items="npc.inventory || []"
        @give="(item) => emit('item-give', item)"
        @remove="(index) => emit('item-remove', index)"
      />
    </div>
  </div>
</template>
