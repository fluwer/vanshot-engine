// Своя подсказка для любого элемента с атрибутом data-tip="текст" (вместо нативного title:
// появляется почти сразу, в стиле интерфейса, с переносом строк, работает и с клавиатуры).
//
// Делегирование на document: подходит и для статического HTML, и для Vue — в шаблоне достаточно
// поставить атрибут (`:data-tip="описание || null"`; пустой/отсутствующий — подсказки нет).
// Один элемент .tip на странице, position: fixed в body, поэтому его не режут ни скролл блока,
// ни overflow модального окна. Текст — только через textContent.
(function () {
  const SHOW_DELAY_MS = 150;
  const GAP = 8;     // зазор между элементом и подсказкой
  const MARGIN = 8;  // отступ от края окна

  let tipEl = null;
  let current = null; // элемент, для которого подсказка показана или ожидается
  let timer = null;

  function ensureEl() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'tip';
      tipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }

  function hide() {
    clearTimeout(timer);
    timer = null;
    current = null;
    if (tipEl) tipEl.classList.remove('tip-visible');
  }

  // Под элементом по центру; не помещается снизу — над ним; по горизонтали зажимаем в окно.
  function place(target) {
    const r = target.getBoundingClientRect();
    const w = tipEl.offsetWidth;
    const h = tipEl.offsetHeight;
    const left = Math.max(MARGIN, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - MARGIN));
    let top = r.bottom + GAP;
    if (top + h > window.innerHeight - MARGIN) top = r.top - GAP - h;
    top = Math.max(MARGIN, top);
    tipEl.style.left = `${Math.round(left)}px`;
    tipEl.style.top = `${Math.round(top)}px`;
  }

  function show(target) {
    if (target !== current || !document.contains(target)) return;
    const text = target.getAttribute('data-tip');
    if (!text) return;
    ensureEl().textContent = text;
    place(target);
    tipEl.classList.add('tip-visible');
  }

  function schedule(target, delay) {
    hide();
    current = target;
    if (delay > 0) timer = setTimeout(() => show(target), delay);
    else show(target);
  }

  const tipTarget = (node) => (node && node.closest ? node.closest('[data-tip]') : null);

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return; // на таче наведения нет
    const target = tipTarget(e.target);
    if (target === current) return;
    if (target) schedule(target, SHOW_DELAY_MS); else hide();
  });
  document.documentElement.addEventListener('pointerleave', hide);

  // С клавиатуры подсказка нужна сразу; фокус от клика мышью (не :focus-visible) её не вызывает —
  // иначе она возвращалась бы после каждого клика по кнопке.
  document.addEventListener('focusin', (e) => {
    const target = tipTarget(e.target);
    if (target && e.target.matches && e.target.matches(':focus-visible')) schedule(target, 0);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', hide, true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);

  window.Tooltip = { hide };
}());
