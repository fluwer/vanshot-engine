<script setup>
import { ref } from 'vue';

const props = defineProps({
  bridge: { type: Object, required: true },
});

// До входа (join) mapController ещё не создан — bridge.mapController станет
// ненулевым только после успешного onJoined(...) в player.js (см. main.js),
// поэтому каждый вызов идёт через опциональную цепочку.
const drawing = ref(false);
const tool = ref('pen');

function toggleDrawing() {
  drawing.value = !drawing.value;
  props.bridge.mapController?.setDrawMode(drawing.value);
}
function setTool(t) {
  tool.value = t;
  props.bridge.mapController?.setDrawTool(t);
}
function undo() {
  props.bridge.socket.emit('drawing:undo');
}
</script>

<template>
  <div class="overlay-body">
    <!-- Разметка и иконки — как во вкладке «Рисование» у ГМ (MapToolsPanel.vue);
         title дублируется в aria-label: на тач-устройствах он не показывается. -->
    <div class="tab-pane tab-pane-flex active">
      <button class="fog-btn fog-toggle" :class="{ active: drawing }" @click="toggleDrawing">✏️ Рисовать</button>
      <div class="fog-group">
        <div class="row" style="gap:4px">
          <button class="fog-btn draw-tool" :class="{ active: tool === 'pen' }" title="Перо" aria-label="Перо" @click="setTool('pen')">🖊️</button>
          <button class="fog-btn draw-tool" :class="{ active: tool === 'eraser' }" title="Ластик — стирает только ваши линии" aria-label="Ластик" @click="setTool('eraser')">🧹</button>
        </div>
      </div>
      <button class="fog-btn wide" @click="undo">↩ Отменить моё действие</button>
    </div>
  </div>
</template>
