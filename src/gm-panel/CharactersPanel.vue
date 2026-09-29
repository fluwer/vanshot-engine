<script setup>
import { ref, computed } from 'vue';
import CharacterCard from './CharacterCard.vue';
import NpcCard from './NpcCard.vue';
import AddEntityForm from './AddEntityForm.vue';
import Modal from './Modal.vue';
import CharacterInfoDialog from './CharacterInfoDialog.vue';
import NpcInfoDialog from './NpcInfoDialog.vue';

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
    <button class="panel-tab" :class="{ active: activeTab === 'characters' }" @click="activeTab = 'characters'">🧑‍🤝‍🧑 Персонажи</button>
    <button class="panel-tab" :class="{ active: activeTab === 'npcs' }" @click="activeTab = 'npcs'">🎭 NPC</button>
  </div>
  <div class="overlay-body">
    <div class="tab-pane" :class="{ active: activeTab === 'characters' }">
      <button class="fog-btn fog-toggle" @click="showAddCharacter = true">➕ Добавить</button>
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
      <button class="fog-btn fog-toggle" @click="showAddNpc = true">➕ Добавить</button>
      <NpcCard
        v-for="n in store.npcs"
        :key="n.id"
        :npc="n"
        :selected="isSelected('npc', n.id)"
        :npc-color="bridge.npcColor"
        :expanded="expandedNpcId === n.id"
        :locations="store.locations"
        @toggle-expand="toggleExpandNpc(n.id)"
        @select="onSelect('npc', n.id)"
        @hp-delta="(d) => emitNpc('npc:hp', n.id, { delta: d })"
        @energy-delta="(d) => emitNpc('npc:energy:update', n.id, { delta: d })"
        @armor-delta="(d) => emitNpc('npc:armor:update', n.id, { delta: d })"
        @visible-toggle="(visible) => emitNpc('npc:visible:set', n.id, { visible })"
        @dead-toggle="(dead) => emitNpc('npc:dead:set', n.id, { dead })"
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
    @close="infoCharacterId = null"
    @code-regenerate="emitCharacter('character:code:regenerate', infoCharacter.id)"
    @update="(data) => emitCharacter('character:update', infoCharacter.id, { data })"
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
    @remove="onRemoveNpc(infoNpc.id)"
  />
</template>
