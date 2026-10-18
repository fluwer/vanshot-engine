import { ref, onBeforeUnmount } from 'vue';

// Текущий пункт левой панели (public/js/dock.js): 'fog' | 'draw' | 'images' | 'vfx' | … | null.
// Открытый блок = активный инструмент карты, поэтому режимы (туман, рисование,
// картинки, эффекты) выводятся из этого значения, а не хранятся в панелях отдельно.
// Общий для обоих бандлов (player-panel и так импортирует компоненты из gm-panel).
export function useDock() {
  const current = ref(window.Dock ? window.Dock.get() : null);
  const onChange = (e) => {
    current.value = e.detail.item;
  };
  document.addEventListener('dock:change', onChange);
  onBeforeUnmount(() => document.removeEventListener('dock:change', onChange));
  return { current };
}
