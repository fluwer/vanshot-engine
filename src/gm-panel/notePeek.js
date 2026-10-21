// v-note-peek="{ type, entity }": при наведении на карточку героя/NPC в правой колонке ГМ видит их заметки в
// плавающем окошке (public/js/notepeek.js, window.NotePeek), не открывая окно «Инфо»; править заметки по-прежнему
// только там. Окошко ставится слева от колонки. Наведение на кнопки, поля, списки, флажки и элементы с data-tip
// (у них своя подсказка, а «−1/+1» не должны прятаться под окошком) его гасит; у карточки без заметок окошка нет.
// Заметки правят, пока курсор стоит, — тогда хук updated обновляет текст окошка. В значении директивы лежат и сами
// поля (notes/secret…): шаблон карточки их не выводит, и без чтения при отрисовке карточка не перерисовывалась бы
// при правке заметок, а updated не срабатывал.
const SKIP = 'button, input, select, textarea, label, [data-tip]';

const handlers = new WeakMap();

function blocksOf(value) {
  const peek = window.NotePeek;
  return peek && value ? peek.blocksFor(value.type, value.entity) : [];
}

export const vNotePeek = {
  mounted(el, binding) {
    const h = { value: binding.value };
    h.over = (e) => {
      const peek = window.NotePeek;
      if (!peek || e.pointerType === 'touch') return; // на таче наведения нет
      const blocks = blocksOf(h.value);
      if (!blocks.length || (e.target instanceof Element && e.target.closest(SKIP))) { peek.hide(el); return; }
      peek.show(blocks, el.getBoundingClientRect(), { owner: el });
    };
    h.leave = () => { if (window.NotePeek) window.NotePeek.hide(el); };
    el.addEventListener('pointerover', h.over);
    el.addEventListener('pointerleave', h.leave);
    handlers.set(el, h);
  },
  updated(el, binding) {
    const h = handlers.get(el);
    if (!h) return;
    h.value = binding.value;
    if (window.NotePeek) window.NotePeek.update(blocksOf(h.value), el);
  },
  unmounted(el) {
    const h = handlers.get(el);
    if (!h) return;
    el.removeEventListener('pointerover', h.over);
    el.removeEventListener('pointerleave', h.leave);
    handlers.delete(el);
    if (window.NotePeek) window.NotePeek.hide(el);
  },
};
