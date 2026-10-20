<script setup>
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useDock } from '../gm-panel/useDock.js';
import Icon from '../gm-panel/Icon.vue';

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
const width = ref(4); // толщина линии, 1…16; в map.js это значение по умолчанию

function setTool(t) {
  tool.value = t;
  props.bridge.mapController?.setDrawTool(t);
}
function onWidthInput() {
  props.bridge.mapController?.setDrawWidth(Number(width.value));
}
function undo() {
  props.bridge.socket.emit('drawing:undo');
}

// Клавиши и колесо карты (X — перо/ластик, [ ] и Ctrl+колесо — толщина; map.js) меняют инструмент и толщину без
// участия панели: узнаём об этом по событию document. Заливку ползунка до бегунка (--p) ведёт ui.js по событиям
// input, программную смену значения догоняем сами.
function onDrawChange(e) {
  const d = e.detail || {};
  tool.value = d.tool;
  width.value = d.width;
  nextTick(() => { if (window.UI) window.UI.syncRanges(); });
}
onMounted(() => document.addEventListener('draw:change', onDrawChange));
onBeforeUnmount(() => document.removeEventListener('draw:change', onDrawChange));
</script>

<template>
  <div class="overlay-body">
    <!-- Разметка и иконки — как у вкладки рисования у ГМ (MapToolsPanel.vue);
         title дублируется в aria-label: на тач-устройствах он не показывается. -->
    <div class="tab-pane tab-pane-flex active">
      <p class="muted small fog-hint">Рисуйте по карте — линии видят все. ПКМ или Ctrl+Z — отменить последний штрих, X — перо/ластик, [ ] или Ctrl+колесо — толщина. Пока блок открыт, ход фишки приостановлен.</p>
      <div class="fog-group">
        <div class="row" style="gap:4px">
          <button class="fog-btn draw-tool" :class="{ active: tool === 'pen' }" title="Перо" aria-label="Перо" @click="setTool('pen')"><Icon name="pen-line" /> Перо</button>
          <button class="fog-btn draw-tool" :class="{ active: tool === 'eraser' }" title="Ластик — стирает только ваши линии" aria-label="Ластик" @click="setTool('eraser')"><Icon name="eraser" /> Ластик</button>
        </div>
      </div>
      <div class="fog-group">
        <span class="fog-label">Толщина: <span>{{ width }}</span></span>
        <input type="range" min="1" max="16" v-model="width" @input="onWidthInput">
      </div>
      <button class="fog-btn wide" @click="undo"><Icon name="undo-2" /> Отменить моё действие</button>
    </div>
  </div>
</template>
