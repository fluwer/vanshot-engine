// v-autosize: textarea сама подбирает высоту под текст (читать длинную «Предысторию» не нужно,
// вытягивая уголок). Пересчёт: при монтировании (после раскладки модалки), на `input`, при
// программной смене значения (v-model → хук updated) и при смене ширины поля (ResizeObserver).
// Выше потолка (≈ половина окна) поле перестаёт расти и прокручивается внутри. Ручное
// растягивание отключено — оно только мешало бы.
const MAX_VH = 0.5;

function fit(el) {
  const max = Math.round(window.innerHeight * MAX_VH);
  el.style.height = 'auto';
  const full = el.scrollHeight + (el.offsetHeight - el.clientHeight); // содержимое + рамка
  el.style.height = `${Math.min(full, max)}px`;
  el.style.overflowY = full > max ? 'auto' : 'hidden';
}

export const vAutosize = {
  mounted(el) {
    el.style.resize = 'none';
    el.__autosize = () => fit(el);
    el.addEventListener('input', el.__autosize);
    fit(el);
    requestAnimationFrame(() => el.isConnected && fit(el)); // модалка могла ещё не получить итоговую ширину
    if (window.ResizeObserver) {
      let lastWidth = el.clientWidth;
      el.__autosizeRO = new ResizeObserver(() => {
        if (el.clientWidth !== lastWidth) { lastWidth = el.clientWidth; fit(el); }
      });
      el.__autosizeRO.observe(el);
    }
  },
  updated(el) {
    fit(el);
  },
  unmounted(el) {
    el.removeEventListener('input', el.__autosize);
    if (el.__autosizeRO) el.__autosizeRO.disconnect();
  },
};
