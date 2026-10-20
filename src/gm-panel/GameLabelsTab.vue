<script setup>
import { reactive, computed, watch } from 'vue';
import Icon from './Icon.vue';
import IconPicker from './IconPicker.vue';
import SkillsEditor from './SkillsEditor.vue';
import { useGame, ATTR_IDS, RESOURCE_IDS, FACTION_IDS } from './useGame';
import { useDock } from './useDock.js';
import { saveGame, resetGame } from './gameSettings';

// Вкладка «Навыки и подписи»: как называются атрибуты, ресурсы и фракции (и какая у них иконка), что
// видят игроки вместо имени скрытого NPC, и каталог навыков. Сами атрибуты, ресурсы и фракции — свойство
// движка (на них завязаны правила), меняются подписи и иконки. Значок фракции на карте закреплён за
// фракцией (разная форма — различие читается и без цвета), поэтому у фракции правятся подпись и цвет.
const props = defineProps({
  bridge: { type: Object, required: true },
  store: { type: Object, required: true },
});

const { config } = useGame();
const dock = useDock();

const draft = reactive({ attributes: {}, resources: {}, factions: {}, hiddenName: '' });

function load() {
  const c = config.value;
  ATTR_IDS.forEach((id) => { draft.attributes[id] = { label: '', icon: 'diamond', ...(c.attributes || {})[id] }; });
  RESOURCE_IDS.forEach((id) => { draft.resources[id] = { label: '', short: '', icon: 'diamond', ...(c.resources || {})[id] }; });
  FACTION_IDS.forEach((id) => { draft.factions[id] = { label: '', color: '#888888', ...(c.factions || {})[id] }; });
  draft.hiddenName = c.hiddenName || '';
}
watch(config, load, { immediate: true });
watch(() => dock.current.value !== 'game', (away) => { if (away) load(); });

function build() {
  const out = { attributes: {}, resources: {}, factions: {}, hiddenName: draft.hiddenName.trim() };
  ATTR_IDS.forEach((id) => { out.attributes[id] = { label: draft.attributes[id].label.trim(), icon: draft.attributes[id].icon }; });
  RESOURCE_IDS.forEach((id) => {
    const r = draft.resources[id];
    out.resources[id] = { label: r.label.trim(), short: r.short.trim(), icon: r.icon };
  });
  FACTION_IDS.forEach((id) => { out.factions[id] = { label: draft.factions[id].label.trim(), color: draft.factions[id].color }; });
  return out;
}

function saved() {
  const c = config.value;
  const out = { attributes: {}, resources: {}, factions: {}, hiddenName: c.hiddenName || '' };
  ATTR_IDS.forEach((id) => { const a = (c.attributes || {})[id] || {}; out.attributes[id] = { label: a.label || '', icon: a.icon || 'diamond' }; });
  RESOURCE_IDS.forEach((id) => { const r = (c.resources || {})[id] || {}; out.resources[id] = { label: r.label || '', short: r.short || '', icon: r.icon || 'diamond' }; });
  FACTION_IDS.forEach((id) => { const f = (c.factions || {})[id] || {}; out.factions[id] = { label: f.label || '', color: f.color || '#888888' }; });
  return out;
}

const dirty = computed(() => JSON.stringify(build()) !== JSON.stringify(saved()));
const valid = computed(() => {
  const p = build();
  return p.hiddenName
    && ATTR_IDS.every((id) => p.attributes[id].label)
    && RESOURCE_IDS.every((id) => p.resources[id].label && p.resources[id].short)
    && FACTION_IDS.every((id) => p.factions[id].label);
});

async function save() {
  await saveGame(props.bridge.socket, build());
}

async function toExample() {
  if (!confirm('Вернуть подписи, иконки и цвета фракций, как в примере игры? Каталог навыков не меняется.')) return;
  const socket = props.bridge.socket;
  const results = await Promise.all(['attributes', 'resources', 'factions', 'hiddenName'].map((s) => resetGame(socket, s, '')));
  if (results.every(Boolean)) window.imageTools.notify('Подписи возвращены к примеру', 'info');
}

const ATTR_HINT = 'Три характеристики героя: к ним прибавляется кубик при проверке.';
const RES_HINT = 'Полная подпись — в листе героя и подсказках, короткая — в тесных карточках ГМ.';
</script>

<template>
  <div class="game-tab">
    <h4 class="game-heading" :data-tip="ATTR_HINT">Атрибуты</h4>
    <div v-for="id in ATTR_IDS" :key="id" class="game-row">
      <IconPicker v-model="draft.attributes[id].icon" label="Иконка атрибута" />
      <input v-model="draft.attributes[id].label" class="game-text" maxlength="24" :aria-label="`Подпись: ${id}`">
    </div>

    <h4 class="game-heading" :data-tip="RES_HINT">Ресурсы</h4>
    <div v-for="id in RESOURCE_IDS" :key="id" class="game-row">
      <IconPicker v-model="draft.resources[id].icon" label="Иконка ресурса" />
      <input v-model="draft.resources[id].label" class="game-text" maxlength="24" placeholder="Полная" :aria-label="`Полная подпись: ${id}`">
      <input v-model="draft.resources[id].short" class="game-short" maxlength="8" placeholder="Кратко" :aria-label="`Короткая подпись: ${id}`">
    </div>
    <p class="muted small game-hint">Здоровье, ход (по клеткам в бою), ресурс для бонуса к броску и броня; их роль в правилах не меняется.</p>

    <h4 class="game-heading">Фракции NPC</h4>
    <div v-for="id in FACTION_IDS" :key="id" class="game-row">
      <input
        v-model="draft.factions[id].color"
        type="color"
        class="game-color"
        :aria-label="`Цвет фракции: ${id}`"
      >
      <input v-model="draft.factions[id].label" class="game-text" maxlength="24" :aria-label="`Подпись фракции: ${id}`">
    </div>

    <h4 class="game-heading">Скрытый NPC</h4>
    <div class="game-row">
      <input v-model="draft.hiddenName" class="game-text" maxlength="30" aria-label="Что видят игроки вместо имени скрытого NPC">
    </div>
    <p class="muted small game-hint">Так игроки видят NPC с отметкой «Скрыть имя».</p>

    <div class="form-actions">
      <button class="primary" :disabled="!dirty || !valid" @click="save"><Icon name="save" /> Сохранить</button>
      <button :disabled="!dirty" @click="load">Отмена</button>
    </div>
    <button type="button" class="small game-reset" @click="toExample">Вернуть подписи как в примере</button>

    <SkillsEditor :bridge="bridge" :skills="store.skillsCatalog" />
  </div>
</template>
