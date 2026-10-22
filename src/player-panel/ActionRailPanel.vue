<script setup>
import { ref, computed } from 'vue';
import Icon from '../gm-panel/Icon.vue';
import DamageDice from '../gm-panel/DamageDice.vue';
import { useGame } from '../gm-panel/useGame';

const props = defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: true },
  // Состояние боя ({ combat: { active, … } }): кубики урона показываем только в бою — в свободном режиме они лишь
  // засоряют панель. Тот же combatStore, что у полосы «Раунд/Ход»: он обновляется после анимации начала боя.
  combat: { type: Object, default: null },
});
const inCombat = computed(() => !!(props.combat && props.combat.combat && props.combat.combat.active));

// Подписи атрибутов и ресурса бонуса, цена и размер бонуса — из настроек игры.
const { attr, res, check } = useGame();
const bonusHint = computed(() => {
  const { cost } = check.value.bonus || {};
  return cost > 0 ? `−${cost} ${res('resolve').label}` : res('resolve').label;
});
const bonusAmount = computed(() => (check.value.bonus || {}).amount);

const character = computed(() => props.store.characters.find((c) => c.id === props.store.myCharacterId));
const spendResolve = ref(false);

function label(key, value) {
  const sign = value >= 0 ? '+' : '';
  return `${attr(key).label} (${sign}${value})`;
}

function roll(key) {
  if (!character.value) return;
  props.bridge.socket.emit('roll', {
    characterId: character.value.id,
    attribute: key,
    spendResolve: spendResolve.value,
  });
  spendResolve.value = false;
}
</script>

<template>
  <div class="attr-buttons">
    <button v-for="(value, key) in character?.attributes" :key="key" @click="roll(key)">{{ label(key, value) }}</button>
  </div>
  <label class="resolve-toggle"><input type="checkbox" v-model="spendResolve"> {{ bonusHint }} <Icon name="arrow-right" /> +{{ bonusAmount }}</label>
  <DamageDice v-if="inCombat" :bridge="bridge" :character-id="character ? character.id : null" />
</template>
