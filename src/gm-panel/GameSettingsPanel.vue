<script setup>
import { ref } from 'vue';
import Icon from './Icon.vue';
import GameLookTab from './GameLookTab.vue';
import GameAssetsTab from './GameAssetsTab.vue';
import GameLabelsTab from './GameLabelsTab.vue';
import GameRulesTab from './GameRulesTab.vue';

// Экран «Игра» (пункт левой панели, только у ГМ): всё, что отличает одну игру от другой при тех же
// правилах движка — название и тема, звуки и ассеты, подписи и навыки, параметры проверок. Правки
// проверяет и хранит сервер (server/gameConfig.js → data/game.json), поэтому переживают рестарт и
// пересборку Docker; игроки получают их в state.game без перезагрузки страницы.
defineProps({
  bridge: { type: Object, required: true },
  store: { type: Object, required: true },
});

const TABS = [
  { id: 'look', label: 'Оформление', icon: 'palette', tip: 'Название игры и цвета интерфейса' },
  { id: 'assets', label: 'Звуки', icon: 'volume-2', tip: 'Звуки интерфейса, примеры из образа, готовые аватары' },
  { id: 'labels', label: 'Подписи', icon: 'pen-line', tip: 'Подписи атрибутов, ресурсов и фракций; каталог навыков' },
  { id: 'rules', label: 'Проверки', icon: 'dices', tip: 'Кубик, криты, бонус, инициатива, сложность, кубики урона' },
];
const tab = ref('look');
</script>

<template>
  <div class="panel-tabs game-tabs" role="tablist">
    <button
      v-for="t in TABS"
      :key="t.id"
      type="button"
      class="panel-tab"
      :class="{ active: tab === t.id }"
      role="tab"
      :aria-selected="tab === t.id"
      :data-tip="t.tip"
      @click="tab = t.id"
    ><Icon :name="t.icon" /><span class="tab-label">{{ t.label }}</span></button>
  </div>
  <div class="overlay-body game-body">
    <!-- Вкладки всегда смонтированы (v-show): черновики не теряются при переключении -->
    <GameLookTab v-show="tab === 'look'" :bridge="bridge" />
    <GameAssetsTab v-show="tab === 'assets'" :bridge="bridge" />
    <GameLabelsTab v-show="tab === 'labels'" :bridge="bridge" :store="store" />
    <GameRulesTab v-show="tab === 'rules'" :bridge="bridge" />
  </div>
</template>
