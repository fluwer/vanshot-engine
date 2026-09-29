<script setup>
import { reactive } from 'vue';

const props = defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: true },
  // Общий store с полем .selected (тот же, что у CharactersPanel/
  // GmAttributesPanel) — отдельно от локального store этой панели
  // (combat/characters/npcs), нужен только чтобы подсветить выбранную
  // на карте строку хода.
  selection: { type: Object, required: true },
});

// Тот же приём, что уже в NpcCard.vue — маленькая статичная константа
// дублируется локально, а не тащится через bridge.
const NPC_FACTIONS = [
  { id: 'enemy', label: 'Враг', icon: '🔴' },
  { id: 'ally', label: 'Союзник', icon: '🟢' },
  { id: 'neutral', label: 'Нейтрал', icon: '⚪' },
];
const NPC_FACTION_BY_ID = Object.fromEntries(NPC_FACTIONS.map((f) => [f.id, f]));

// picked — состояние чеклиста участников. Ключ 'type:id' -> checked.
// Живёт в компоненте (не в store), поэтому переживает обновления store
// (новые ссылки на массивы characters/npcs при каждом socket 'state') без
// сброса отмеченных чекбоксов — раньше это решалось флагом combatSetupBuilt
// в gm.js, здесь он больше не нужен.
const picked = reactive({});

function togglePicked(type, id) {
  const key = `${type}:${id}`;
  picked[key] = !picked[key];
}

// Отмечает всех неубитых одним кликом — обычно ГМ ведёт бой почти всей
// партией+NPC, вручную кликать 8-12 чекбоксов на старте каждого боя неудобно.
// Мёртвых не трогаем — если ГМ уже отметил мёртвого вручную, отметка остаётся.
function pickAllAlive() {
  props.store.characters.forEach((c) => { if (!c.dead) picked[`character:${c.id}`] = true; });
  props.store.npcs.forEach((n) => { if (!n.dead) picked[`npc:${n.id}`] = true; });
}
function pickNone() {
  Object.keys(picked).forEach((key) => { picked[key] = false; });
}

function onStart() {
  const participants = Object.entries(picked)
    .filter(([, checked]) => checked)
    .map(([key]) => {
      const [type, id] = key.split(':');
      return { type, id };
    });
  if (!participants.length) return;
  props.bridge.socket.emit('combat:start', { participants });
}

function factionFor(entry) {
  if (entry.type !== 'npc') return null;
  const npc = props.store.npcs.find((n) => n.id === entry.id);
  return npc ? NPC_FACTION_BY_ID[npc.faction || 'neutral'] : null;
}

function turnRowClass(entry, index) {
  const classes = { current: index === props.store.combat.currentIndex };
  const faction = factionFor(entry);
  if (faction) classes[`faction-${faction.id}`] = true;
  classes.selected = isRowSelected(entry);
  return classes;
}

// Клик по строке хода выделяет участника на карте — тот же bridge.selectTarget,
// что использует CharactersPanel при клике по карточке.
function isRowSelected(entry) {
  return props.selection.selected?.type === entry.type && props.selection.selected?.id === entry.id;
}
function onRowClick(entry) {
  props.bridge.selectTarget(entry.type, isRowSelected(entry) ? null : entry.id);
}
</script>

<template>
  <div class="overlay-body">
    <div v-if="!store.combat.active">
      <div class="row" style="gap:4px">
        <button class="fog-btn" title="Отметить всех живых персонажей и NPC" @click="pickAllAlive">Выбрать живых</button>
        <button class="fog-btn" title="Снять все отметки" @click="pickNone">Сбросить</button>
      </div>
      <div class="combat-pick-list">
        <div class="combat-pick-group-label">🧑‍🤝‍🧑 Персонажи</div>
        <label v-for="c in store.characters" :key="`character-${c.id}`" class="combat-pick" :class="{ dead: c.dead }">
          <input type="checkbox" :checked="picked[`character:${c.id}`]" @change="togglePicked('character', c.id)"> {{ c.name }}<span v-if="c.dead" title="Убит"> ☠</span>
        </label>
        <div class="combat-pick-group-label">🎭 NPC</div>
        <label v-for="n in store.npcs" :key="`npc-${n.id}`" class="combat-pick" :class="{ dead: n.dead }">
          <input type="checkbox" :checked="picked[`npc:${n.id}`]" @change="togglePicked('npc', n.id)"> {{ n.name }}<span v-if="n.dead" title="Убит"> ☠</span><span v-if="!n.dead && !n.visible" title="Скрыт от игроков"> 🙈</span>
        </label>
      </div>
      <button class="small wide" title="Бросить инициативу (d20 + Тело) и начать бой отмеченными участниками" @click="onStart">🎲 Начать бой</button>
    </div>
    <div v-else>
      <div class="row" style="justify-content:space-between">
        <strong>Раунд {{ store.combat.round }}</strong>
        <button class="small" title="Завершить бой" @click="bridge.socket.emit('combat:end')">⏹ Завершить бой</button>
      </div>
      <div class="combat-turn-list">
        <div
          v-for="(entry, i) in store.combat.order"
          :key="`${entry.type}-${entry.id}`"
          class="combat-turn-row"
          :class="turnRowClass(entry, i)"
          @click="onRowClick(entry)"
        >
          <span>{{ factionFor(entry) ? `${factionFor(entry).icon} ` : '' }}{{ entry.name }}</span>
          <span class="muted small" title="Инициатива">🎲 {{ entry.initiative }}</span>
        </div>
      </div>
      <button class="small wide" title="Передать ход следующему участнику" @click="bridge.socket.emit('combat:next')">⏭ Следующий ход</button>
    </div>
  </div>
</template>
