<script setup>
import { computed } from 'vue';
import Icon from './Icon.vue';
import { useUiScale } from './useUiScale.js';

// Пункт «Вид»: масштаб интерфейса (панели, журнал, диалоги — не карта). Общий для ГМ и игрока; настройка личная
// (хранится на этом устройстве, public/js/uiscale.js). Увеличение ограничено шириной окна — раскладка рассчитана
// на ~1000 логических пикселей.
const { scale, setScale, limits } = useUiScale();

const PRESETS = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
const chosenPercent = computed(() => Math.round(scale.value.chosen * 100));
const effectivePercent = computed(() => Math.round(scale.value.effective * 100));

function onSlider(e) {
  setScale(Number(e.target.value) / 100);
}
</script>

<template>
  <div class="overlay-body">
    <div class="fog-group">
      <span class="fog-label"><Icon name="scaling" /> Масштаб интерфейса: <span>{{ chosenPercent }}%</span></span>
      <input
        type="range"
        :min="Math.round(limits.min * 100)"
        :max="Math.round(limits.max * 100)"
        :step="Math.round(limits.step * 100)"
        :value="chosenPercent"
        aria-label="Масштаб интерфейса"
        @input="onSlider"
      >
      <div class="view-presets">
        <button
          v-for="p in PRESETS"
          :key="p"
          type="button"
          class="small"
          :class="{ active: Math.abs(scale.chosen - p) < 0.001 }"
          @click="setScale(p)"
        >{{ Math.round(p * 100) }}%</button>
      </div>
      <p v-if="scale.clamped" class="muted small">Окно узковато для {{ chosenPercent }}%: сейчас показывается {{ effectivePercent }}%. Растяните окно — масштаб вернётся.</p>
      <p class="muted small">Меняет размер панелей, журнала и диалогов. Карта не масштабируется — у неё свой зум (колесо мыши). Настройка хранится на этом устройстве.</p>
    </div>
  </div>
</template>
