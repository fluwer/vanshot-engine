import { ref, onBeforeUnmount } from 'vue';

// Блок «ресурсы» — FPS и прочее (public/js/perfhud.js): включён ли он на этом устройстве. Состояние живёт в legacy-скрипте
// (localStorage), Vue только подписывается на событие perfhud:change — как useUiScale/useWeather. Общий для обоих бандлов.
export function usePerfHud() {
  const api = window.PerfHud;
  const visible = ref(api ? api.isVisible() : false);
  const onChange = (e) => {
    visible.value = !!(e.detail && e.detail.visible);
  };
  document.addEventListener('perfhud:change', onChange);
  onBeforeUnmount(() => document.removeEventListener('perfhud:change', onChange));
  const setVisible = (v) => api && api.setVisible(v);
  return { visible, setVisible };
}
