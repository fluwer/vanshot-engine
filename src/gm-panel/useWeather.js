import { ref, onBeforeUnmount } from 'vue';

// Погода на экране (public/js/weather.js): { mode, intensity, enabled, reduced, label }.
// Состояние живёт в legacy-скрипте (его кормит state с сервера и личный выключатель), Vue только
// подписывается на событие weather:change — как useDock с dock:change. Общий для обоих бандлов.
export function useWeather() {
  const weather = ref(window.weather
    ? window.weather.get()
    : { mode: 'off', intensity: 1, enabled: true, reduced: false, label: 'Нет' });
  const onChange = (e) => {
    weather.value = e.detail;
  };
  document.addEventListener('weather:change', onChange);
  onBeforeUnmount(() => document.removeEventListener('weather:change', onChange));
  const setEnabled = (on) => window.weather && window.weather.setEnabled(on);
  return { weather, setEnabled };
}
