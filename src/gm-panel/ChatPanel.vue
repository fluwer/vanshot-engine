<script setup>
import { onMounted } from 'vue';

// chat.js — тот же black-box паттерн, что и soundboard.js/music.js: он общий
// с player.js (см. public/js/player.js), поэтому не трогаем сам chat.js —
// панель просто владеет статичной разметкой (те же id) и вызывает initChat
// один раз при монтировании. renderChat(state.chat) по-прежнему вызывается
// напрямую из gm.js — рендер ленты идёт мимо Vue.
// gmControls передаётся true только из gm-panel/main.js — компонент общий
// с игроком (player-panel/main.js монтирует без этого пропа), поэтому
// кнопка очистки чата видна только мастеру.
const props = defineProps({
  bridge: { type: Object, required: true },
  gmControls: { type: Boolean, default: false },
});

onMounted(() => {
  window.initChat(props.bridge.socket);
});
</script>

<template>
  <div class="chat-feed" id="chat-feed"></div>
  <form class="chat-form" id="chat-form">
    <div class="chat-suggest" id="chat-suggest"></div>
    <input id="chat-input" class="chat-input" placeholder="Сообщение…" maxlength="300" autocomplete="off">
    <button type="submit" class="small">Отправить</button>
    <button v-if="gmControls" type="button" class="small" @click="bridge.socket.emit('chat:clear')">Очистить</button>
  </form>
</template>
