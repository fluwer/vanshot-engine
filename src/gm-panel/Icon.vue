<script setup>
import { computed } from 'vue';

// Иконка интерфейса из реестра public/js/icons.js (window.Icons) — вместо эмодзи.
// Общий компонент: используется и в GM-панели, и в player-panel (как EffectsPanel).
// Цвет — currentColor (берёт цвет текста кнопки), размер по умолчанию — 1.15em от шрифта;
// size (px) задаёт явный. Неизвестное имя (например, старый эмодзи из данных) показывается
// текстом — обратная совместимость.
const props = defineProps({
  name: { type: String, default: '' },
  size: { type: [Number, String], default: null },
});

const inner = computed(() => (window.Icons && window.Icons.has(props.name) ? window.Icons.inner(props.name) : ''));
</script>

<template>
  <svg
    v-if="inner"
    class="ico"
    :width="size || undefined"
    :height="size || undefined"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    v-html="inner"
  ></svg>
  <span v-else-if="name" class="ico ico-text">{{ name }}</span>
</template>
