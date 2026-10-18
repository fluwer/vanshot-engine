import { createApp, reactive } from 'vue';
import JoinForm from './JoinForm.vue';
import PartyPanel from './PartyPanel.vue';
import SheetDrawerPanel from './SheetDrawerPanel.vue';
import SkillsInventoryPanel from './SkillsInventoryPanel.vue';
import DiceLogPanel from '../gm-panel/DiceLogPanel.vue';
import ChatPanel from '../gm-panel/ChatPanel.vue';
import CombatIndicatorPanel from './CombatIndicatorPanel.vue';
import SoundboardPanel from './SoundboardPanel.vue';
import MusicPanel from './MusicPanel.vue';
import DrawingPanel from './DrawingPanel.vue';
import EffectsPanel from '../gm-panel/EffectsPanel.vue';
import LocationBadge from '../gm-panel/LocationBadge.vue';
import ActionRailPanel from './ActionRailPanel.vue';
import MyImagesPanel from './MyImagesPanel.vue';

// player.js (обычный не-модульный скрипт) грузится раньше этого бандла и
// успевает выставить window.playerBridge синхронно при загрузке страницы —
// см. public/js/player.js. Берём ТУ ЖЕ ссылку на объект (без спреда в
// новый объект, как в gm-panel), потому что mapController в bridge
// появляется позже (после join) через мутацию существующего объекта —
// player.js делает window.playerBridge.mapController = mapController.
const bridge = window.playerBridge;

const charactersStore = reactive({ characters: [], skillsCatalog: [], myCharacterId: null });
window.charactersStoreApp = {
  updateState(characters, skillsCatalog) {
    charactersStore.characters = characters;
    charactersStore.skillsCatalog = skillsCatalog;
  },
  setMyCharacterId(id) {
    charactersStore.myCharacterId = id;
  },
};

createApp(JoinForm, { store: charactersStore, bridge }).mount('#join-form-vue-root');
createApp(PartyPanel, { store: charactersStore }).mount('#party-panel-vue-root');
createApp(SheetDrawerPanel, { store: charactersStore }).mount('#sheet-drawer-vue-root');
createApp(SkillsInventoryPanel, { store: charactersStore }).mount('#skills-drawer-vue-root');
createApp(ActionRailPanel, { store: charactersStore, bridge }).mount('#action-rail-vue-root');

const diceLogStore = reactive({ diceLog: [] });
createApp(DiceLogPanel, { store: diceLogStore }).mount('#dicelog-panel-vue-root');
window.diceLogPanelApp = {
  updateState(diceLog) {
    diceLogStore.diceLog = diceLog;
  },
};

createApp(ChatPanel, { bridge }).mount('#chat-panel-vue-root');
createApp(SoundboardPanel, { bridge }).mount('#soundboard-panel-vue-root');
createApp(MusicPanel, { bridge }).mount('#music-panel-vue-root');
createApp(DrawingPanel, { bridge }).mount('#drawing-panel-vue-root');
createApp(EffectsPanel, { bridge }).mount('#effects-panel-vue-root');

// ---- Мои картинки: игрок правит СВОИ картинки на карте (после «Принять» ГМ) ----
// Данные кормит player.js (state.mapImages, выбор картинки на канвасе). Панель по
// умолчанию закрыта — открывается сама после принятия картинки (focus).
const imagesStore = reactive({ images: [], myCharacterId: null, selectedId: null, editing: false });
createApp(MyImagesPanel, { store: imagesStore, bridge }).mount('#images-panel-vue-root');
window.imagesPanelApp = {
  updateState(images) {
    imagesStore.images = images || [];
  },
  setMyCharacterId(id) {
    imagesStore.myCharacterId = id;
  },
  setSelected(id) {
    imagesStore.selectedId = id;
  },
  // После «Принять»: открыть панель, включить режим правки, выделить картинку и показать её.
  focus(id) {
    const mc = bridge.mapController;
    const panel = document.getElementById('images-panel');
    if (panel) window.PanelDrag.showPanel(panel, 'playerPanel');
    if (!mc) return;
    mc.setImageEditMode(true);
    imagesStore.editing = true;
    mc.selectMapImage(id);
    imagesStore.selectedId = id;
    const img = imagesStore.images.find((m) => m.id === id);
    if (img) mc.centerCameraOn(img.x, img.y);
  },
};

// ---- Строка «Текущая локация» (общий компонент с ГМ) ----
const locationBadgeStore = reactive({ name: '' });
createApp(LocationBadge, { store: locationBadgeStore }).mount('#location-badge-vue-root');
window.locationBadgeApp = {
  updateState(name) {
    locationBadgeStore.name = name || '';
  },
};

// ---- Бой ----
// fxHolding/pendingCombatState — гейтинг обновлений на время анимации кубиков
// инициативы (combatfx.js), 1:1 та же схема, что в gm-panel/main.js.
const combatStore = reactive({ combat: { active: false, round: 0, order: [], currentIndex: 0 }, npcs: [] });
let fxHolding = false;
let pendingCombatState = null;
window.combatPanelApp = {
  updateState(combat, npcs) {
    if (fxHolding) {
      pendingCombatState = { combat, npcs };
    } else {
      combatStore.combat = combat;
      combatStore.npcs = npcs;
    }
  },
  setFxHolding(holding) {
    fxHolding = holding;
    if (!holding && pendingCombatState) {
      combatStore.combat = pendingCombatState.combat;
      combatStore.npcs = pendingCombatState.npcs;
      pendingCombatState = null;
    }
  },
};
createApp(CombatIndicatorPanel, { store: combatStore }).mount('#combat-indicator-vue-root');
