<script setup>
import { onMounted } from 'vue';

const props = defineProps({
  bridge: { type: Object, required: true },
});

// soundboard.js — «чёрный ящик»: кэширует document.getElementById один раз
// при init и дальше правит DOM напрямую (см. SoundPanel.vue у ГМ).
onMounted(() => {
  window.initSoundboard(props.bridge.socket, 'soundboard-list');
});
</script>

<template>
  <div class="overlay-body soundboard-list">
    <div id="soundboard-list" class="soundboard-list"></div>
  </div>
</template>
