<script setup>
import { ref, watch } from 'vue';
import { useDock } from './useDock.js';
import { useWeather } from './useWeather.js';
import { useFogFx } from './useFogFx.js';
import Icon from './Icon.vue';

// Роле-независимая панель — переиспользуется и в GM-панели, и в
// player-panel (см. main.js обоих бандлов), как DiceLogPanel/ChatPanel.
// gm — только у ГМ: кнопки погоды (режим и интенсивность для всех); личный
// выключатель погоды показывается всем.
const props = defineProps({
  bridge: { type: Object, required: true },
  gm: { type: Boolean, default: false },
});

// ---- Погода на экране (public/js/weather.js): одна на всю игру, задаёт ГМ ----
const { weather, setEnabled } = useWeather();
// Туман войны у игрока (public/js/fogfx.js): личный выключатель «живого» тумана. ГМ он не нужен —
// у него туман всегда квадратами клеток для точной правки.
const { fog, setEnabled: setFogEnabled } = useFogFx();
const WEATHER_MODES = [
  { mode: 'off', label: 'Нет', icon: 'ban' },
  { mode: 'cold', label: 'Холод', icon: 'snowflake' },
  { mode: 'wind', label: 'Ветер', icon: 'wind' },
  { mode: 'blizzard', label: 'Метель', icon: 'cloud-snow' },
];
const WEATHER_INTENSITIES = [
  { value: 1, label: 'Слабо' },
  { value: 2, label: 'Средне' },
  { value: 3, label: 'Сильно' },
];
function setWeather(patch) {
  props.bridge.socket.emit('weather:set', patch);
}

// Эффекты — инструмент левой панели (пункт 'vfx'): «заряд» живёт, только пока блок
// открыт. Закрыли блок или выбрали другой пункт — снимаем, иначе клик по карте
// продолжал бы ставить эффект. Это же снимает прежний скрытый конфликт приоритета
// «эффект / рисование / туман»: открыт всегда один пункт.
const dock = useDock();
watch(() => dock.current.value, (item) => {
  if (item !== 'vfx' && armed.value) {
    armed.value = null;
    props.bridge.mapController?.setVfxPlaceMode(null);
  }
});

const TYPES = [
  { type: 'smoke', label: 'Дым', icon: 'wind' },
  { type: 'fire', label: 'Огонь', icon: 'flame' },
  { type: 'firework', label: 'Фейерверк', icon: 'party-popper' },
  { type: 'explosion', label: 'Взрыв', icon: 'bomb' },
  { type: 'lightning', label: 'Молния', icon: 'zap' },
  { type: 'magic', label: 'Магия', icon: 'wand-sparkles' },
];

// Режим "заряжен" — не гасится после одного клика по карте (можно ставить
// эффекты подряд), выключается повторным нажатием той же кнопки. См.
// mapController.setVfxPlaceMode в public/js/map.js.
const armed = ref(null);

function toggle(type) {
  armed.value = armed.value === type ? null : type;
  props.bridge.mapController?.setVfxPlaceMode(armed.value);
}
</script>

<template>
  <div class="overlay-body">
    <p class="muted small">Выберите эффект, затем кликните по карте — можно ставить несколько подряд.</p>
    <div class="vfx-grid">
      <button
        v-for="t in TYPES"
        :key="t.type"
        class="fog-btn"
        :class="{ active: armed === t.type }"
        @click="toggle(t.type)"
      ><Icon :name="t.icon" /> {{ t.label }}</button>
    </div>

    <div class="weather-section">
      <span class="fog-label">Погода</span>
      <template v-if="gm">
        <div class="weather-modes">
          <button
            v-for="m in WEATHER_MODES"
            :key="m.mode"
            class="fog-btn"
            :class="{ active: weather.mode === m.mode }"
            @click="setWeather({ mode: m.mode })"
          ><Icon :name="m.icon" /> {{ m.label }}</button>
        </div>
        <div v-show="weather.mode !== 'off'" class="weather-intensity">
          <button
            v-for="i in WEATHER_INTENSITIES"
            :key="i.value"
            class="fog-btn"
            :class="{ active: weather.intensity === i.value }"
            @click="setWeather({ intensity: i.value })"
          >{{ i.label }}</button>
        </div>
        <p class="muted small">Одна погода на всю игру — её видят все. На картинках карты погоды нет.</p>
      </template>
      <p v-else class="muted small">Сейчас: {{ weather.label }}</p>
      <label class="npc-flag-toggle" title="Выключатель только на этом экране"><input type="checkbox" :checked="weather.enabled" @change="setEnabled($event.target.checked)"> Показывать погоду у меня</label>
      <p v-if="weather.reduced" class="muted small">Отключена системой: включено «уменьшение движения».</p>
    </div>

    <div v-if="!gm" class="weather-section">
      <span class="fog-label">Туман</span>
      <label class="npc-flag-toggle" title="Выключатель только на этом экране"><input type="checkbox" :checked="fog.enabled" @change="setFogEnabled($event.target.checked)"> Живой туман у меня</label>
      <p class="muted small">Мягкие края с колышущейся дымкой. Выключите, если картинка тормозит: края останутся мягкими, но неподвижными.</p>
      <p v-if="fog.reduced" class="muted small">Дымка не движется: включено «уменьшение движения».</p>
      <p v-else-if="fog.enabled && fog.mode !== 'full'" class="muted small">Движение упрощено: экран не успевает отрисовывать кадры.</p>
    </div>
  </div>
</template>
