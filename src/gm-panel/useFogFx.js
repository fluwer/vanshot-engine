import { ref, onBeforeUnmount } from 'vue';

// «Живой» туман у игрока (public/js/fogfx.js): { enabled, reduced, mode }. Состояние живёт в legacy-скрипте
// (личный выключатель, reduced-motion, авто-упрощение при тяжёлых кадрах), Vue только подписывается на событие
// fogfx:change — как useWeather с weather:change. Общий для обоих бандлов.
export function useFogFx() {
  const fog = ref(window.fogFx
    ? window.fogFx.get()
    : { enabled: true, reduced: false, mode: 'full' });
  const onChange = (e) => {
    fog.value = e.detail;
  };
  document.addEventListener('fogfx:change', onChange);
  onBeforeUnmount(() => document.removeEventListener('fogfx:change', onChange));
  const setEnabled = (on) => window.fogFx && window.fogFx.setEnabled(on);
  return { fog, setEnabled };
}
