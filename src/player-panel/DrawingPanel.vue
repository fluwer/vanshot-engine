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
    <button class="fog-btn fog-toggle" :class="{ active: drawing }" @click="toggleDrawing">✏️ Рисовать</button>
    <div class="fog-group">
      <span class="fog-label">Инструмент</span>
      <div class="row" style="gap:4px">
        <button class="fog-btn draw-tool" :class="{ active: tool === 'pen' }" @click="setTool('pen')">Перо</button>
        <button class="fog-btn draw-tool" :class="{ active: tool === 'eraser' }" @click="setTool('eraser')">Ластик</button>
      </div>
    </div>
    <button class="fog-btn wide" @click="undo">↩ Отменить моё действие</button>
  </div>
</template>
