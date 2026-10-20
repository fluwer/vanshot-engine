import { ref, onBeforeUnmount } from 'vue';

// Масштаб интерфейса (public/js/uiscale.js): { chosen, effective, clamped } + границы. Состояние живёт в legacy-скрипте
// (localStorage, ограничение по ширине окна), Vue только подписывается на событие uiscale:change — как
// useWeather/useFogFx. Общий для обоих бандлов.
export function useUiScale() {
  const api = window.UiScale;
  const scale = ref(api ? api.get() : { chosen: 1, effective: 1, clamped: false });
  const onChange = (e) => {
    scale.value = e.detail;
  };
  document.addEventListener('uiscale:change', onChange);
  onBeforeUnmount(() => document.removeEventListener('uiscale:change', onChange));
  const setScale = (v) => api && api.set(v);
  const limits = api ? { min: api.MIN, max: api.MAX, step: api.STEP } : { min: 0.7, max: 1.5, step: 0.05 };
  return { scale, setScale, limits };
}
