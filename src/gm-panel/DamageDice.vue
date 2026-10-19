<script setup>
import Icon from './Icon.vue';

// Кубик урона: кнопки d4…d12 в нижней панели ГМ и игрока. Бросок только показывается всем
// (кубик на экране + запись в журнале); HP не меняется — урон ГМ применяет на карточке цели
// (поле «Урон», броня учтена). Допустимые размеры проверяет сервер (config.DAMAGE_DICE).
// characterId: у ГМ — выбранная фишка (нет цели — бросок «от Мастера»); у игрока не важен —
// сервер бросает за его собственного персонажа.
defineProps({
  bridge: { type: Object, required: true },
  characterId: { type: String, default: null },
});

const DICE = [4, 6, 8, 10, 12];
</script>

<template>
  <div class="damage-dice">
    <span class="damage-dice-label" data-tip="Кубик урона: бросок виден всем; HP не меняется — урон применяет ГМ на карточке цели"><Icon name="sword" /> Урон</span>
    <button
      v-for="n in DICE"
      :key="n"
      type="button"
      class="small"
      :data-tip="`Бросок урона d${n}`"
      :aria-label="`Бросок урона d${n}`"
      @click="bridge.socket.emit('roll:damage', { characterId, sides: n })"
    >d{{ n }}</button>
  </div>
</template>
