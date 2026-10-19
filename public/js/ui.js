// Мелкая поддержка контролов, которую нельзя сделать одним CSS.
//
//  Ползунки (input[type=range]): заливка трека «до бегунка» — градиент по CSS-переменной --p
//  (controls.css). Пересчитываем её на каждое `input`; значения, выставленные программно
//  (громкость в music.js, v-model в Vue), событий не шлют — их подхватывает
//  UI.syncRanges() при загрузке страницы, после показа блока (dock:change) и на `change`.
(function () {
  function syncRange(el) {
    const min = el.min === '' ? 0 : Number(el.min);
    const max = el.max === '' ? 100 : Number(el.max);
    const value = Number(el.value);
    const span = max - min;
    const p = span > 0 ? ((value - min) / span) * 100 : 0;
    el.style.setProperty('--p', `${Math.max(0, Math.min(100, p))}%`);
  }

  function syncRanges(root) {
    (root || document).querySelectorAll('input[type=range]').forEach(syncRange);
  }

  function onInput(e) {
    const t = e.target;
    if (t && t.matches && t.matches('input[type=range]')) syncRange(t);
  }
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onInput, true);
  document.addEventListener('dock:change', () => requestAnimationFrame(() => syncRanges()));
  window.addEventListener('load', () => syncRanges());
  document.addEventListener('DOMContentLoaded', () => syncRanges());

  window.UI = { syncRanges };
}());
