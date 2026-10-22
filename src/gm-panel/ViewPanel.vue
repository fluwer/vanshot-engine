<script setup>
import { computed } from 'vue';
import Icon from './Icon.vue';
import { useUiScale } from './useUiScale.js';
import { usePerfHud } from './usePerfHud.js';

// Пункт «Вид»: масштаб интерфейса (панели, журнал, диалоги — не карта) и блок «ресурсы» (FPS и прочее). Общий для ГМ и
// игрока; настройки личные (хранятся на этом устройстве, public/js/uiscale.js и perfhud.js). Увеличение ограничено шириной
// окна — раскладка рассчитана на ~1000 логических пикселей.
const { scale, setScale, limits } = useUiScale();
const { visible: hudVisible, setVisible: setHudVisible } = usePerfHud();

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
    <div class="fog-group">
      <label class="npc-flag-toggle">
        <input type="checkbox" :checked="hudVisible" aria-label="Показывать FPS и ресурсы" @change="setHudVisible($event.target.checked)">
        <Icon name="cpu" /> Показывать FPS и ресурсы
      </label>
      <p class="muted small">Справа внизу: FPS и время кадра, цена отрисовки карты, память страницы, пинг до сервера; у мастера ещё число картинок и клеток тумана. Настройка хранится на этом устройстве.</p>
    </div>
  </div>
</template>
