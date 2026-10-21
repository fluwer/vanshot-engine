<script setup>
import { computed, ref } from 'vue';
import StatRow from './StatRow.vue';
import InventoryEditor from './InventoryEditor.vue';
import Icon from './Icon.vue';
import { useGame } from './useGame';
import { vNotePeek } from './notePeek.js';

const props = defineProps({
  npc: { type: Object, required: true },
  selected: { type: Boolean, default: false },
  npcColor: { type: String, default: '#c05656' },
  // { enemy|ally|neutral: { color, icon } } из public/js/map.js — запасной аватар красим цветом
  // фракции, как кольцо токена на карте (иначе карточка и токен выглядели бы по-разному).
  factionStyle: { type: Object, default: null },
  // См. CharacterCard.vue — состояние раскрытия живёт в родителе (аккордеон).
  expanded: { type: Boolean, default: false },
  // Полный список локаций — для селекта переноса NPC (см. TODO.md «Локации»).
  locations: { type: Array, default: () => [] },
});
const emit = defineEmits([
  'select', 'hp-delta', 'energy-delta', 'armor-delta', 'damage-apply',
  'item-give', 'item-remove', 'visible-toggle', 'dead-toggle', 'name-hidden-toggle', 'faction-set', 'info', 'toggle-expand',
  'location-set',
]);

// Фракции (подпись, значок, цвет), подписи ресурсов и имя скрытого NPC — из настроек игры.
const { config: gameConfig, res, faction, factionIds } = useGame();
const NPC_FACTIONS = computed(() => factionIds.map(faction));

const avatarColor = computed(() => {
  const style = props.factionStyle && (props.factionStyle[props.npc.faction] || props.factionStyle.neutral);
  return (style && style.color) || props.npcColor;
});

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
  <div class="card compact npc-mini" :class="{ selected }" v-note-peek="{ type: 'npc', entity: npc, notes: npc.notes, secret: npc.secret, role: npc.role }" @click="handleCardClick">
    <div class="row" style="gap:6px">
      <img v-if="npc.avatar" class="gm-avatar" :src="npc.avatar" alt="">
      <span v-else class="gm-avatar gm-avatar-fallback" :style="{ background: avatarColor }">{{ npc.name[0] }}</span>
      <h3 style="margin:0">{{ npc.name }} ({{ npc.role }})<Icon v-if="npc.nameHidden" name="eye-off" class="npc-name-hidden-ico" :data-tip="`Имя скрыто: игроки видят «${gameConfig.hiddenName}»`" /></h3>
      <button class="small npc-info-toggle" title="Инфо-карточка" aria-label="Инфо-карточка" @click="emit('info')"><Icon name="info" /></button>
      <button class="small" title="Свернуть/развернуть" aria-label="Свернуть/развернуть" @click="emit('toggle-expand')"><Icon :name="expanded ? 'chevron-down' : 'chevron-right'" /></button>
    </div>

    <div class="row gm-stat-row" style="gap:6px 10px; flex-wrap: wrap">
      <label class="npc-flag-toggle">
        <input type="checkbox" :checked="npc.visible" @change="emit('visible-toggle', $event.target.checked)"> Виден игрокам
      </label>
      <label class="npc-flag-toggle">
        <input type="checkbox" :checked="npc.dead" @change="emit('dead-toggle', $event.target.checked)"> <Icon name="skull" /> Убит
      </label>
      <label class="npc-flag-toggle" :data-tip="`Игроки видят «${gameConfig.hiddenName}» вместо имени и роли (на карте, в порядке хода и журнале бросков)`">
        <input type="checkbox" :checked="npc.nameHidden" @change="emit('name-hidden-toggle', $event.target.checked)"> <Icon name="eye-off" /> Скрыть имя
      </label>
    </div>

    <div class="row" style="gap:4px">
      <button
        v-for="f in NPC_FACTIONS"
        :key="f.id"
        class="fog-btn npc-faction-btn"
        :class="{ active: (npc.faction || 'neutral') === f.id }"
        :title="f.label"
        :aria-label="f.label"
        @click="emit('faction-set', f.id)"
      ><Icon :name="f.icon" :class="`fico-${f.id}`" /></button>
    </div>

    <div v-if="locations.length > 1" class="row gm-stat-row" style="gap:6px">
      <label class="npc-flag-toggle">Локация:
        <select class="fog-btn" :value="npc.locationId" @change="emit('location-set', $event.target.value)" @click.stop>
          <option v-for="loc in locations" :key="loc.id" :value="loc.id">{{ loc.name }}</option>
        </select>
      </label>
    </div>

    <StatRow :label="res('hp').short" :current="npc.hp.current" :max="npc.hp.max" bar-class="npc" @delta="(d) => emit('hp-delta', d)" />
    <div v-show="expanded">
      <StatRow :label="res('energy').short" :current="npc.energy.current" :max="npc.energy.max" bar-class="energy" @delta="(d) => emit('energy-delta', d)" />
      <StatRow :label="res('armor').short" mode="value" :current="npc.armor" @delta="(d) => emit('armor-delta', d)" />

      <div class="row gm-stat-row">
        <input class="gm-item-input gm-damage-input" type="number" min="1" placeholder="Урон" v-model="damageAmount">
        <button class="small gm-damage-apply" title="Применить урон" aria-label="Применить урон" @click="applyDamage"><Icon name="sword" /></button>
      </div>

      <InventoryEditor
        :items="npc.inventory || []"
        @give="(item) => emit('item-give', item)"
        @remove="(index) => emit('item-remove', index)"
      />
    </div>
  </div>
</template>
