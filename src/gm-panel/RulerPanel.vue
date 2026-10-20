<script setup>
import { computed, ref, watch } from 'vue';
import { useDock } from './useDock.js';
import { useGame } from './useGame';

// Роле-независимая панель «Линейка» — переиспользуется и в GM-панели, и в
// player-panel (см. main.js обоих бандлов), как EffectsPanel. Меряет расстояние
// между двумя клетками; линия и показания видны только тому, кто мерит —
// на сервер и другим участникам ничего не уходит (см. mapController, map.js).
const props = defineProps({
  bridge: { type: Object, required: true },
});

// { moves, straight } | null — приходит из map.js при каждом движении линии.
const reading = ref(null);

// Линейка — инструмент левой панели (пункт 'ruler'): режим включён, пока блок открыт,
// и выключается закрытием (повторный клик, ✕, Esc) или выбором другого пункта —
// тогда линия тоже убирается. У игрока mapController появляется только после join,
// поэтому берём его в момент переключения, а не при монтировании.
const dock = useDock();
watch(() => dock.current.value === 'ruler', (on) => {
  const mc = props.bridge.mapController;
  if (!mc) return;
  if (on) mc.setRulerChangeHandler((r) => { reading.value = r; });
  mc.setRulerMode(on);
  if (!on) reading.value = null;
});

const { res } = useGame(); // ресурс движения (по умолчанию «Энергия») — из настроек игры
const energyName = computed(() => res('energy').label.toLowerCase());

const straightText = computed(() => (reading.value ? String(reading.value.straight).replace('.', ',') : ''));

function clear() {
  props.bridge.mapController?.clearRuler();
}
</script>

<template>
  <div class="overlay-body">
    <div class="tab-pane tab-pane-flex active">
      <p class="muted small fog-hint">
        Нажмите и тяните по карте — начало и конец привязываются к клеткам. Линия видна только вам.
        Пока блок открыт, выбор и ход фишек приостановлены.
      </p>
      <div class="ruler-reading">
        <div class="ruler-row">
          <span class="muted" :title="`Манхэттен: столько ресурса «${energyName}» стоит такой ход в бою`">Ход (как {{ energyName }})</span>
          <strong>{{ reading ? `${reading.moves} кл.` : '—' }}</strong>
        </div>
        <div class="ruler-row">
          <span class="muted" title="Расстояние по прямой, в клетках">По прямой</span>
          <strong>{{ reading ? `${straightText} кл.` : '—' }}</strong>
        </div>
      </div>
      <button class="fog-btn wide" :disabled="!reading" @click="clear">Убрать линию</button>
    </div>
  </div>
</template>
