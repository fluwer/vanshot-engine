import { createApp, reactive } from 'vue';
import CharactersPanel from './CharactersPanel.vue';
import DiceLogPanel from './DiceLogPanel.vue';
import SoundPanel from './SoundPanel.vue';
import CombatPanel from './CombatPanel.vue';
import MapToolsPanel from './MapToolsPanel.vue';
import TopBarPanel from './TopBarPanel.vue';
import GmAttributesPanel from './GmAttributesPanel.vue';
import ChatPanel from './ChatPanel.vue';
import EffectsPanel from './EffectsPanel.vue';

// gm.js (обычный не-модульный скрипт) грузится раньше этого бандла и
// успевает выставить window.gmSocket/window.gmBridge синхронно при загрузке
// страницы — см. public/js/gm.js.
const socket = window.gmSocket;
const bridge = { ...window.gmBridge, socket };

const store = reactive({
  characters: [],
  npcs: [],
  skillsCatalog: {},
  selected: null,
  locations: [],
});

const app = createApp(CharactersPanel, { store, bridge });
app.mount('#characters-panel-vue-root');

// Мост назад в gm.js: он вызывает эти методы вместо старых
// renderCharacters/renderNpcs при каждом socket 'state' и при смене
// выделения на карте.
window.charactersPanelApp = {
  updateState(characters, npcs, skillsCatalog, locations) {
    store.characters = characters;
    store.npcs = npcs;
    if (skillsCatalog) store.skillsCatalog = skillsCatalog;
    store.locations = locations || [];
  },
  setSelected(target) {
    store.selected = target;
  },
};

// ---- Лог бросков ----
const diceLogStore = reactive({ diceLog: [] });
createApp(DiceLogPanel, { store: diceLogStore, bridge }).mount('#dicelog-panel-vue-root');
window.diceLogPanelApp = {
  updateState(diceLog) {
    diceLogStore.diceLog = diceLog;
  },
};

// ---- Звук (саундборд + музыка) ----
// soundboard.js/music.js остаются как есть — панель просто владеет их
// статичной разметкой и вызывает их init-функции при монтировании.
createApp(SoundPanel, { bridge }).mount('#sound-panel-vue-root');

// ---- Бой ----
// fxHolding/pendingCombatState — гейтинг обновлений на время анимации
// кубиков инициативы (combatfx.js), перенесённый сюда из gm.js: сама
// панель остаётся простым рендерером уже готового store.combat.
const combatStore = reactive({
  combat: { active: false, round: 0, order: [], currentIndex: 0 },
  characters: [],
  npcs: [],
});
let fxHolding = false;
let pendingCombatState = null;
window.combatPanelApp = {
  updateState(combat, characters, npcs) {
    if (fxHolding) {
      pendingCombatState = { combat, characters, npcs };
    } else {
      combatStore.combat = combat;
      combatStore.characters = characters;
      combatStore.npcs = npcs;
    }
  },
  setFxHolding(holding) {
    fxHolding = holding;
    if (!holding && pendingCombatState) {
      combatStore.combat = pendingCombatState.combat;
      combatStore.characters = pendingCombatState.characters;
      combatStore.npcs = pendingCombatState.npcs;
      pendingCombatState = null;
    }
  },
};
createApp(CombatPanel, { store: combatStore, selection: store, bridge }).mount('#combat-panel-vue-root');

// ---- Инструменты карты (туман/картинки/рисование) ----
const mapToolsStore = reactive({ mapImages: [], locations: [], activeLocationId: null });
createApp(MapToolsPanel, { store: mapToolsStore, bridge }).mount('#maptools-panel-vue-root');
window.mapToolsPanelApp = {
  updateState(mapImages, locations, activeLocationId) {
    mapToolsStore.mapImages = mapImages;
    mapToolsStore.locations = locations || [];
    mapToolsStore.activeLocationId = activeLocationId;
  },
};

// ---- Верхняя панель (DC) ----
const topBarStore = reactive({ currentDc: 0 });
createApp(TopBarPanel, { store: topBarStore, bridge }).mount('#topbar-vue-root');
window.dcControlsPanelApp = {
  updateState(currentDc) {
    topBarStore.currentDc = currentDc;
  },
};

// ---- Бросок за выбранного персонажа (action-rail) ----
// Переиспользует тот же store, что и CharactersPanel (characters/npcs/selected).
createApp(GmAttributesPanel, { store, bridge }).mount('#action-rail-vue-root');

// ---- Чат ----
createApp(ChatPanel, { bridge, gmControls: true }).mount('#chat-panel-vue-root');

// ---- Спецэффекты (дым/огонь/фейерверк) ----
createApp(EffectsPanel, { bridge }).mount('#effects-panel-vue-root');
