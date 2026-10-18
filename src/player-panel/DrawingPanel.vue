<script setup>
import { ref, watch } from 'vue';
import { useDock } from '../gm-panel/useDock.js';

const props = defineProps({
  bridge: { type: Object, required: true },
});

// Рисование — инструмент левой панели (пункт 'draw'): режим включён, пока блок
// открыт, и выключается закрытием (повторный клик, ✕, Esc) или выбором другого пункта.
// До входа (join) mapController ещё не создан — bridge.mapController станет
// ненулевым только после успешного onJoined(...) в player.js (см. main.js),
// поэтому каждый вызов идёт через опциональную цепочку.
const dock = useDock();
watch(() => dock.current.value === 'draw', (on) => {
  props.bridge.mapController?.setDrawMode(on);
});

const tool = ref('pen');

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
    <!-- Разметка и иконки — как у вкладки рисования у ГМ (MapToolsPanel.vue);
         title дублируется в aria-label: на тач-устройствах он не показывается. -->
    <div class="tab-pane tab-pane-flex active">
      <p class="muted small fog-hint">Рисуйте по карте — линии видят все. ПКМ — отменить последний штрих. Пока блок открыт, ход фишки приостановлен.</p>
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
