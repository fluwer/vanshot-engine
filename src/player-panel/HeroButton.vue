<script setup>
import Icon from '../gm-panel/Icon.vue';

// Плавающая кнопка «К герою» (игрок): появляется, только когда фишки героя не видно на экране, и плавно возвращает камеру
// к нему (mapController.flyToMyCharacter; то же делает пробел). Стрелка показывает, в какую сторону герой.
// view — { visible, angle } от map.js (setHeroViewHandler → player.js → window.heroButtonApp.update): видимость и
// направление в градусах от «вправо» по часовой, шаг 15°. Пока камера летит, map.js считает героя «видимым» — кнопка скрыта.
const props = defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: true },
});

// mapController появляется у игрока только после входа (player.js мутирует bridge) — берём его в момент клика.
function fly() {
  const mc = props.bridge.mapController;
  if (mc) mc.flyToMyCharacter();
}
</script>

<template>
  <Transition name="hero-btn">
    <button
      v-if="!store.visible"
      type="button"
      class="hero-btn"
      data-tip="Вернуть камеру к вашему герою (пробел)"
      aria-label="Назад к герою"
      @click="fly"
    >
      <Icon name="locate-fixed" />
      <span class="hero-btn-label">К герою</span>
      <Icon name="arrow-right" class="hero-btn-dir" :style="{ transform: `rotate(${store.angle}deg)` }" />
    </button>
  </Transition>
</template>
