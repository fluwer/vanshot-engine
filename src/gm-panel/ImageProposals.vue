<script setup>
import Icon from './Icon.vue';
// Плавающая НЕ блокирующая карточка: игроки предложили картинку (Ctrl+V) и ждут
// решения ГМ. Картинка на карте появляется только после «Принять»; предложения
// живут в памяти сервера (см. gameState.proposeMapImage), сюда их присылают
// события mapimage:proposed / mapimage:pending:sync (public/js/gm.js).
const props = defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: true },
});

function approve(p) {
  props.bridge.socket.emit('mapimage:approve', { id: p.id }, (ack) => {
    if (ack && ack.ok && ack.entry) {
      // Явное решение ГМ — показываем, куда легла картинка. Режим редактирования
      // и вкладку не трогаем: activeEditMode живёт внутри MapToolsPanel.vue.
      props.bridge.mapController.centerCameraOn(ack.entry.x, ack.entry.y);
    } else {
      // Уже обработано/просрочено — убираем карточку, чтобы не висела.
      props.store.proposals = props.store.proposals.filter((x) => x.id !== p.id);
      window.imageTools?.notify('Не удалось принять картинку (предложение устарело)', 'error');
    }
  });
}

function reject(p) {
  props.bridge.socket.emit('mapimage:reject', { id: p.id });
}
</script>

<template>
  <div v-if="store.proposals.length" class="proposals-card" role="alert">
    <div class="proposals-title"><Icon name="image" /> Игроки предлагают картинки ({{ store.proposals.length }})</div>
    <div v-for="p in store.proposals" :key="p.id" class="proposal-row">
      <img class="proposal-thumb" :src="p.dataUrl" :alt="p.name">
      <div class="proposal-body">
        <div class="proposal-author">{{ p.authorName }}</div>
        <div class="proposal-name muted small">{{ p.name }}</div>
        <div class="row" style="gap:4px">
          <button class="fog-btn primary" @click="approve(p)"><Icon name="check" /> Принять</button>
          <button class="fog-btn danger" @click="reject(p)"><Icon name="x" /> Отклонить</button>
        </div>
      </div>
    </div>
  </div>
</template>
