<script setup>
import { ref, computed, reactive, watch } from 'vue';
import CharacterCard from './CharacterCard.vue';
import NpcCard from './NpcCard.vue';
import AddEntityForm from './AddEntityForm.vue';
import Modal from './Modal.vue';
import CharacterInfoDialog from './CharacterInfoDialog.vue';
import NpcInfoDialog from './NpcInfoDialog.vue';
import Icon from './Icon.vue';

const props = defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: true },
});

const activeTab = ref('characters');
const showAddCharacter = ref(false);
const showAddNpc = ref(false);
const infoCharacterId = ref(null);
const infoNpcId = ref(null);

// Аккордеон: обычно ГМ ведёт игру с одним активным персонажем/NPC на виду —
// раскрытие одной карточки схлопывает остальные (в рамках своего таба,
// персонажи и NPC — независимые списки). По умолчанию всё свёрнуто (null).
const expandedCharacterId = ref(null);
const expandedNpcId = ref(null);
function toggleExpandCharacter(id) {
  expandedCharacterId.value = expandedCharacterId.value === id ? null : id;
}
function toggleExpandNpc(id) {
  expandedNpcId.value = expandedNpcId.value === id ? null : id;
}

// ---- Фильтры вкладки «NPC» ----
// Чисто клиентские: показывают подмножество `store.npcs`, на сервер ничего не шлют и `state` не меняют.
// «Эта локация» включена по умолчанию и запоминается вместе с остальными (localStorage ГМа); при одной локации
// чип не показывается и не применяется. Выбранный на карте NPC всегда с открытой локации — фильтр его не прячет.
const FILTER_KEY = 'vanshot:npcFilter';
const VIS_MODES = [
  { id: 'all', label: 'Все' },
  { id: 'visible', label: 'Видимые' },
  { id: 'hidden', label: 'Скрытые' },
];
const FILTER_DEFAULTS = { onlyHere: true, vis: 'all', hideDead: false };

function loadFilter() {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_KEY));
    if (raw && typeof raw === 'object') {
      return {
        onlyHere: raw.onlyHere !== false,
        vis: VIS_MODES.some((m) => m.id === raw.vis) ? raw.vis : 'all',
        hideDead: raw.hideDead === true,
      };
    }
  } catch (e) { /* нет значения, битый JSON или localStorage недоступен — значения по умолчанию */ }
  return { ...FILTER_DEFAULTS };
}
const filter = reactive(loadFilter());
watch(filter, () => {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(filter)); } catch (e) { /* приватный режим — живёт до перезагрузки */ }
}, { deep: true });

const multiLocation = computed(() => (props.store.locations || []).length > 1);
const hereOnly = computed(() => multiLocation.value && filter.onlyHere);
const filterActive = computed(() => hereOnly.value || filter.vis !== 'all' || filter.hideDead);
const filteredNpcs = computed(() => props.store.npcs.filter((n) => {
  if (hereOnly.value && n.locationId !== props.store.activeLocationId) return false;
  if (filter.vis === 'visible' && !n.visible) return false;
  if (filter.vis === 'hidden' && n.visible) return false;
  if (filter.hideDead && n.dead) return false;
  return true;
}));
function clearFilter() {
  filter.onlyHere = false;
  filter.vis = 'all';
  filter.hideDead = false;
}
// Раскрытая карточка, которую фильтр спрятал, не должна «висеть» невидимо раскрытой.
watch(filteredNpcs, (list) => {
  if (expandedNpcId.value && !list.some((n) => n.id === expandedNpcId.value)) expandedNpcId.value = null;
});

const infoCharacter = computed(() => props.store.characters.find((c) => c.id === infoCharacterId.value) || null);
const infoNpc = computed(() => props.store.npcs.find((n) => n.id === infoNpcId.value) || null);

function isSelected(type, id) {
  return props.store.selected?.type === type && props.store.selected?.id === id;
}

function onSelect(type, id) {
  const already = isSelected(type, id);
  props.bridge.selectTarget(type, already ? null : id);
}

function emitCharacter(event, characterId, extra) {
  props.bridge.socket.emit(event, { characterId, ...extra });
}
function emitNpc(event, npcId, extra) {
  props.bridge.socket.emit(event, { npcId, ...extra });
}

function onRemoveCharacter(characterId) {
  emitCharacter('character:remove', characterId);
}
function onRemoveNpc(npcId) {
  emitNpc('npc:remove', npcId);
}
function onAddCharacter(data) {
  props.bridge.socket.emit('character:add', { data });
  showAddCharacter.value = false;
}
function onAddNpc(data) {
  props.bridge.socket.emit('npc:add', { data });
  showAddNpc.value = false;
}
</script>

<template>
  <div class="panel-tabs">
    <button class="panel-tab" :class="{ active: activeTab === 'characters' }" @click="activeTab = 'characters'"><Icon name="users" /> Персонажи</button>
    <button class="panel-tab" :class="{ active: activeTab === 'npcs' }" @click="activeTab = 'npcs'"><Icon name="drama" /> NPC</button>
  </div>
  <div class="overlay-body">
    <div class="tab-pane" :class="{ active: activeTab === 'characters' }">
      <button class="fog-btn fog-toggle" @click="showAddCharacter = true"><Icon name="plus" /> Добавить</button>
      <CharacterCard
        v-for="c in store.characters"
        :key="c.id"
        :character="c"
        :selected="isSelected('character', c.id)"
        :expanded="expandedCharacterId === c.id"
        @toggle-expand="toggleExpandCharacter(c.id)"
        @select="onSelect('character', c.id)"
        @hp-delta="(d) => emitCharacter('hp:update', c.id, { delta: d })"
        @energy-delta="(d) => emitCharacter('energy:update', c.id, { delta: d })"
        @resolve-delta="(d) => emitCharacter('resolve:update', c.id, { delta: d })"
        @armor-delta="(d) => emitCharacter('armor:update', c.id, { delta: d })"
        @dead-toggle="(dead) => emitCharacter('character:dead:set', c.id, { dead })"
        @item-give="(item) => emitCharacter('item:give', c.id, { item })"
        @item-remove="(index) => emitCharacter('item:remove', c.id, { index })"
        @damage-apply="(amount) => bridge.socket.emit('combat:damage', { targetType: 'character', targetId: c.id, amount })"
        @info="infoCharacterId = c.id"
      />
    </div>
    <div class="tab-pane" :class="{ active: activeTab === 'npcs' }">
      <button class="fog-btn fog-toggle" @click="showAddNpc = true"><Icon name="plus" /> Добавить</button>
      <div class="npc-filter" role="group" aria-label="Фильтры NPC">
        <div class="npc-filter-row">
          <button
            v-if="multiLocation"
            type="button"
            class="fog-btn npc-filter-chip"
            :class="{ active: filter.onlyHere }"
            :aria-pressed="filter.onlyHere"
            data-tip="Показывать только NPC открытой локации"
            @click="filter.onlyHere = !filter.onlyHere"
          ><Icon name="map-pin" /> Эта локация</button>
          <button
            type="button"
            class="fog-btn npc-filter-chip"
            :class="{ active: filter.hideDead }"
            :aria-pressed="filter.hideDead"
            data-tip="Убрать из списка убитых NPC"
            @click="filter.hideDead = !filter.hideDead"
          ><Icon name="skull" /> Без убитых</button>
        </div>
        <div class="npc-filter-row" role="group" aria-label="Видимость для игроков" data-tip="Видны ли NPC игрокам (флажок «Виден игрокам» на карточке)">
          <span class="npc-filter-label muted small">Видимость:</span>
          <button
            v-for="m in VIS_MODES"
            :key="m.id"
            type="button"
            class="fog-btn npc-filter-chip"
            :class="{ active: filter.vis === m.id }"
            :aria-pressed="filter.vis === m.id"
            @click="filter.vis = m.id"
          >{{ m.label }}</button>
        </div>
        <div v-if="filterActive" class="npc-filter-foot muted small">
          <span class="npc-filter-count">Показано {{ filteredNpcs.length }} из {{ store.npcs.length }}</span>
          <button type="button" class="small npc-filter-clear" @click="clearFilter"><Icon name="x" /> Снять все</button>
        </div>
      </div>
      <p v-if="store.npcs.length && !filteredNpcs.length" class="npc-filter-empty muted small">Нет NPC по фильтру. <button type="button" class="small" @click="clearFilter">Показать всех</button></p>
      <NpcCard
        v-for="n in filteredNpcs"
        :key="n.id"
        :npc="n"
        :selected="isSelected('npc', n.id)"
        :npc-color="bridge.npcColor"
        :faction-style="bridge.npcFactionStyle"
        :expanded="expandedNpcId === n.id"
        :locations="store.locations"
        @toggle-expand="toggleExpandNpc(n.id)"
        @select="onSelect('npc', n.id)"
        @hp-delta="(d) => emitNpc('npc:hp', n.id, { delta: d })"
        @energy-delta="(d) => emitNpc('npc:energy:update', n.id, { delta: d })"
        @armor-delta="(d) => emitNpc('npc:armor:update', n.id, { delta: d })"
        @visible-toggle="(visible) => emitNpc('npc:visible:set', n.id, { visible })"
        @dead-toggle="(dead) => emitNpc('npc:dead:set', n.id, { dead })"
        @name-hidden-toggle="(hidden) => emitNpc('npc:namehidden:set', n.id, { hidden })"
        @faction-set="(faction) => emitNpc('npc:faction:set', n.id, { faction })"
        @location-set="(locationId) => emitNpc('npc:location:set', n.id, { locationId })"
        @item-give="(item) => emitNpc('npc:item:give', n.id, { item })"
        @item-remove="(index) => emitNpc('npc:item:remove', n.id, { index })"
        @damage-apply="(amount) => bridge.socket.emit('combat:damage', { targetType: 'npc', targetId: n.id, amount })"
        @info="infoNpcId = n.id"
      />
    </div>
  </div>

  <Modal v-if="showAddCharacter" @close="showAddCharacter = false">
    <template #title>Новый персонаж</template>
    <AddEntityForm kind="character" @submit="onAddCharacter" @cancel="showAddCharacter = false" />
  </Modal>
  <Modal v-if="showAddNpc" @close="showAddNpc = false">
    <template #title>Новый NPC</template>
    <AddEntityForm kind="npc" @submit="onAddNpc" @cancel="showAddNpc = false" />
  </Modal>

  <CharacterInfoDialog
    v-if="infoCharacter"
    :character="infoCharacter"
    :skills-catalog="store.skillsCatalog"
    :avatar-preset-urls="bridge.getNpcAvatarPresetUrls()"
    :resize-image="bridge.resizeImage"
    @close="infoCharacterId = null"
    @code-regenerate="emitCharacter('character:code:regenerate', infoCharacter.id)"
    @update="(data) => emitCharacter('character:update', infoCharacter.id, { data })"
    @avatar-preset="(presetUrl) => emitCharacter('avatar:set', infoCharacter.id, { presetUrl })"
    @avatar-upload="(dataUrl) => emitCharacter('avatar:upload', infoCharacter.id, { dataUrl })"
    @avatar-clear="emitCharacter('avatar:set', infoCharacter.id, { presetUrl: null })"
    @remove="onRemoveCharacter(infoCharacter.id)"
  />
  <NpcInfoDialog
    v-if="infoNpc"
    :npc="infoNpc"
    :avatar-preset-urls="bridge.getNpcAvatarPresetUrls()"
    :resize-image="bridge.resizeImage"
    @close="infoNpcId = null"
    @update="(data) => emitNpc('npc:update', infoNpc.id, { data })"
    @avatar-preset="(presetUrl) => emitNpc('npc:avatar:set', infoNpc.id, { presetUrl })"
    @avatar-upload="(dataUrl) => emitNpc('npc:avatar:upload', infoNpc.id, { dataUrl })"
    @avatar-clear="emitNpc('npc:avatar:set', infoNpc.id, { presetUrl: null })"
    @remove="onRemoveNpc(infoNpc.id)"
  />
</template>
