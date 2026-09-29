<script setup>
import { onMounted } from 'vue';

const props = defineProps({
  bridge: { type: Object, required: true },
});

// music.js — «чёрный ящик» (см. SoundPanel.vue у ГМ). У игрока роль 'player':
// нет выбора трека и play/pause/stop, только «сейчас играет» и своя громкость.
onMounted(() => {
  window.initMusicPlayer(props.bridge.socket, {
    role: 'player',
    nowPlayingId: 'music-now-playing',
    volumeId: 'music-volume',
    volumeValueId: 'music-volume-value',
  });
});
</script>

<template>
  <div class="overlay-body">
    <p class="muted small" id="music-now-playing">Тишина</p>
    <div class="fog-group">
      <span class="fog-label">Громкость: <span id="music-volume-value">50</span>%</span>
      <input id="music-volume" type="range" min="0" max="100" value="50">
    </div>
  </div>
</template>
