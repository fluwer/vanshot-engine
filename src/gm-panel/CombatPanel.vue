<script setup>
import { reactive, computed } from 'vue';
import Icon from './Icon.vue';
import { useGame } from './useGame';

const props = defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: true },
  // Общий store с полем .selected (тот же, что у CharactersPanel/
  // GmAttributesPanel) — отдельно от локального store этой панели
  // (combat/characters/npcs), нужен только чтобы подсветить выбранную
  // на карте строку хода.
  selection: { type: Object, required: true },
});

// Фракции NPC (подпись, значок, цвет), кубик и атрибут инициативы — из настроек игры.
const { faction, attr, check } = useGame();
const initiativeHint = computed(() => `${check.value.die ? `d${check.value.die}` : 'd20'} + ${attr(check.value.initiativeAttr || 'body').label}`);

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
  locationNpcs.value.forEach((n) => { if (!n.dead) picked[`npc:${n.id}`] = true; });
}
function pickNone() {
  Object.keys(picked).forEach((key) => { picked[key] = false; });
}

// В чеклисте — только NPC открытой локации: остальных на карте нет, в бой их не позвать.
// store.npcs остаётся полным (фракции строк хода ищутся по нему).
const locationNpcs = computed(() => props.store.npcs.filter((n) => n.locationId === props.store.activeLocationId));

function onStart() {
  // picked переживает смену локации: отметка ушедшего с карты NPC не должна попасть в бой «невидимкой».
  const shown = new Set([
    ...props.store.characters.map((c) => `character:${c.id}`),
    ...locationNpcs.value.map((n) => `npc:${n.id}`),
  ]);
  const participants = Object.entries(picked)
    .filter(([key, checked]) => checked && shown.has(key))
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
  return npc ? faction(['enemy', 'ally', 'neutral'].includes(npc.faction) ? npc.faction : 'neutral') : null;
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
        <div class="combat-pick-group-label"><Icon name="users" /> Персонажи</div>
        <label v-for="c in store.characters" :key="`character-${c.id}`" class="combat-pick" :class="{ dead: c.dead }">
          <input type="checkbox" :checked="picked[`character:${c.id}`]" @change="togglePicked('character', c.id)"> {{ c.name }}<Icon v-if="c.dead" name="skull" class="ico-dead" title="Убит" />
        </label>
        <div class="combat-pick-group-label"><Icon name="drama" /> NPC</div>
        <label v-for="n in locationNpcs" :key="`npc-${n.id}`" class="combat-pick" :class="{ dead: n.dead }">
          <input type="checkbox" :checked="picked[`npc:${n.id}`]" @change="togglePicked('npc', n.id)"> {{ n.name }}<Icon v-if="n.dead" name="skull" class="ico-dead" title="Убит" /><Icon v-if="!n.dead && !n.visible" name="eye-off" class="ico-dead" title="Скрыт от игроков" />
        </label>
        <div v-if="!locationNpcs.length" class="combat-pick-empty muted small">На этой локации нет NPC</div>
      </div>
      <button class="small wide primary" :title="`Бросить инициативу (${initiativeHint}) и начать бой отмеченными участниками`" @click="onStart"><Icon name="d20" /> Начать бой</button>
    </div>
    <div v-else>
      <div class="row" style="justify-content:space-between">
        <strong>Раунд {{ store.combat.round }}</strong>
        <button class="small danger" title="Завершить бой" @click="bridge.socket.emit('combat:end')"><Icon name="square" /> Завершить бой</button>
      </div>
      <div class="combat-turn-list">
        <div
          v-for="(entry, i) in store.combat.order"
          :key="`${entry.type}-${entry.id}`"
          class="combat-turn-row"
          :class="turnRowClass(entry, i)"
          @click="onRowClick(entry)"
        >
          <span class="ico-label"><Icon v-if="factionFor(entry)" :name="factionFor(entry).icon" :class="`fico-${factionFor(entry).id}`" />{{ entry.name }}</span>
          <span class="muted small ico-label" title="Инициатива"><Icon name="d20" /> {{ entry.initiative }}</span>
        </div>
      </div>
      <button class="small wide" title="Передать ход следующему участнику" @click="bridge.socket.emit('combat:next')"><Icon name="skip-forward" /> Следующий ход</button>
    </div>
  </div>
</template>
