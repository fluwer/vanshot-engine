import { shallowRef, computed } from 'vue';

// Настройки игры (public/js/game.js, на сервере — server/gameConfig.js) в реактивном виде для Vue.
// Идентификаторы атрибутов, ресурсов и фракций — свойство движка (на них завязаны правила), а подписи,
// иконки, параметры проверок и название задаёт игра: компоненты берут их отсюда, а не пишут в шаблонах.
// Общий для обоих бандлов (gm-panel и player-panel), как useDock.
//
//   const { attr, res, faction, check, config } = useGame();
//   attr('body').label → «Тело»;  res('resolve').short → «Реш.»;  faction('enemy').icon → 'faction-enemy'
export const ATTR_IDS = ['body', 'mind', 'charisma'];
export const RESOURCE_IDS = ['hp', 'energy', 'resolve', 'armor'];
export const FACTION_IDS = ['enemy', 'ally', 'neutral'];

// Одно значение на бандл: подписка на Game — один раз при загрузке модуля (бандл живёт всё время жизни страницы).
const config = shallowRef(window.Game ? window.Game.config : {});
if (window.Game) window.Game.onChange((next) => { config.value = next; });

function entry(section, id, fallbackIcon) {
  const e = (config.value[section] || {})[id] || {};
  return { id, label: e.label || id, short: e.short || e.label || id, icon: e.icon || fallbackIcon, color: e.color };
}

export function useGame() {
  return {
    config,
    attr: (id) => entry('attributes', id, 'diamond'),
    res: (id) => entry('resources', id, 'diamond'),
    faction: (id) => entry('factions', id, 'faction-neutral'),
    // Параметры проверок: кубик, пороги критов, бонус за ресурс, атрибут инициативы, пресеты DC, кубики урона.
    check: computed(() => config.value.check || {}),
    attrIds: ATTR_IDS,
    resourceIds: RESOURCE_IDS,
    factionIds: FACTION_IDS,
  };
}
