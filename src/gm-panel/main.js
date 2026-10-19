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
import LocationBadge from './LocationBadge.vue';
import ImageProposals from './ImageProposals.vue';
import CombatStrip from './CombatStrip.vue';
import RulerPanel from './RulerPanel.vue';

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
// Полоса «Раунд/Ход» сверху по центру — тот же store, видна только в бою.
createApp(CombatStrip, { store: combatStore }).mount('#combat-strip-vue-root');

// ---- Инструменты карты (туман/картинки/рисование/локации) ----
// Один блок на четыре пункта левой панели (Dock): вкладку и режим карты выбирает
// открытый пункт (см. MapToolsPanel.vue, useDock.js).
const mapToolsStore = reactive({ mapImages: [], locations: [], activeLocationId: null });
createApp(MapToolsPanel, { store: mapToolsStore, bridge }).mount('#maptools-panel-vue-root');
window.mapToolsPanelApp = {
  updateState(mapImages, locations, activeLocationId) {
    mapToolsStore.mapImages = mapImages;
    mapToolsStore.locations = locations || [];
    mapToolsStore.activeLocationId = activeLocationId;
  },
};

// ---- Строка «Текущая локация» ----
const locationBadgeStore = reactive({ name: '' });
createApp(LocationBadge, { store: locationBadgeStore, clickable: true }).mount('#location-badge-vue-root');
window.locationBadgeApp = {
  updateState(name) {
    locationBadgeStore.name = name || '';
  },
};

// ---- Предложения картинок от игроков (Ctrl+V с согласованием ГМ) ----
// События mapimage:proposed / pending:sync / proposal:closed приходят в gm.js и
// попадают сюда; плюс при монтировании сами запрашиваем очередь — события могли
// прийти раньше, чем загрузился этот бандл, а сервер повторно их не шлёт.
const imageProposalsStore = reactive({ proposals: [] });
createApp(ImageProposals, { store: imageProposalsStore, bridge }).mount('#image-proposals-vue-root');
window.imageProposalsApp = {
  add(p) {
    if (imageProposalsStore.proposals.some((x) => x.id === p.id)) return;
    imageProposalsStore.proposals.push(p);
    window.imageTools?.ping();
  },
  remove(id) {
    imageProposalsStore.proposals = imageProposalsStore.proposals.filter((p) => p.id !== id);
  },
  sync(list) {
    imageProposalsStore.proposals = Array.isArray(list) ? list : [];
  },
};
socket.emit('mapimage:pending', {}, (list) => window.imageProposalsApp.sync(list));

// ---- Нижняя панель, правая часть (DC, бросок мастера, восстановление) ----
const topBarStore = reactive({ currentDc: 0 });
createApp(TopBarPanel, { store: topBarStore, bridge }).mount('#topbar-vue-root');
window.dcControlsPanelApp = {
  updateState(currentDc) {
    topBarStore.currentDc = currentDc;
  },
};

// ---- Бросок за выбранного персонажа (нижняя панель, левая часть) ----
// Переиспользует тот же store, что и CharactersPanel (characters/npcs/selected).
createApp(GmAttributesPanel, { store, bridge }).mount('#action-rail-vue-root');

// ---- Чат (вкладка «Чат» журнала, см. public/js/journal.js) ----
createApp(ChatPanel, { bridge, gmControls: true }).mount('#chat-panel-vue-root');

// ---- Спецэффекты (дым/огонь/фейерверк) ----
createApp(EffectsPanel, { bridge, gm: true }).mount('#effects-panel-vue-root');

// ---- Линейка (пункт левой панели; режим ведёт сама панель по dock:change) ----
createApp(RulerPanel, { bridge }).mount('#ruler-panel-vue-root');
