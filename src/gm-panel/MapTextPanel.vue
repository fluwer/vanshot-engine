<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { useDock } from './useDock.js';
import { vAutosize } from './autosize.js';
import { request, toast } from './gameSettings';

// Блок «Текст» (только ГМ): заметки на карте поверх картинок — «заметки для самих картинок», игроки их не видят
// (сервер вообще не отправляет их игрокам, см. getGMState). Режим карты включён, пока блок открыт (пункт Dock 'text'):
// клик по заметке выбирает и тащит её, двойной клик по пустому месту — новая заметка, по заметке — правка текста здесь,
// Delete — удалить. Данные кормит gm.js через window.mapTextPanelApp (main.js): store.texts — заметки открытой локации,
// store.selectedId — выбранная (и с канваса, и из списка — один путь: mapController.selectMapText).
const props = defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: true },
});

const SIZES = [
  { id: 's', label: 'S', tip: 'Мелкий текст' },
  { id: 'm', label: 'M', tip: 'Средний текст' },
  { id: 'l', label: 'L', tip: 'Крупный текст' },
];
// Цвет заметки — ключ токена темы (смена темы красит заметки), поэтому swatch берёт var(--токен).
const COLORS = [
  { id: 'text', token: '--text', label: 'Белый' },
  { id: 'accent', token: '--accent', label: 'Голубой' },
  { id: 'amber', token: '--amber', label: 'Янтарный' },
  { id: 'danger', token: '--danger', label: 'Красный' },
  { id: 'ok', token: '--ok', label: 'Зелёный' },
];
const TEXT_MAX = 500; // = MAP_TEXT_MAX_LENGTH в server/config.js (сервер всё равно проверяет)
const SAVE_DELAY_MS = 300;
const REASONS = {
  limit: 'Слишком много заметок (не больше 200)',
  'invalid:text': 'Текст: от 1 до 500 символов',
  'invalid:size': 'Размер задан неверно',
  'invalid:color': 'Цвет задан неверно',
  'invalid:position': 'Положение задано неверно',
  'not-found': 'Заметки уже нет — обновите страницу',
  'no-response': 'Сервер не ответил',
};
const reason = (r) => REASONS[r] || `Не принято: ${r}`;

const socket = props.bridge.socket;
const mc = () => props.bridge.mapController;

const texts = computed(() => props.store.texts);
const selected = computed(() => texts.value.find((t) => t.id === props.store.selectedId) || null);

// Режим карты = открытый пункт Dock (как RulerPanel/MapToolsPanel): закрыли блок — режим выключается, выбор снимается.
const dock = useDock();
watch(() => dock.current.value === 'text', (on) => {
  const controller = mc();
  if (controller) controller.setTextEditMode(on);
});

// ---- Поле текста выбранной заметки ----
// draft — то, что набрано; уходит на сервер через SAVE_DELAY_MS после последнего ввода и сразу при потере фокуса или смене
// выбора (flush). Ответ сервера draft не перезаписывает — иначе курсор прыгал бы посреди набора. Пустой текст сервер не
// принимает: прежний остаётся, а при уходе из поля draft возвращается к нему.
const draft = ref('');
const editor = ref(null);
const saveError = ref('');
let saveTimer = null;
let pending = null; // { id, text }

async function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const job = pending;
  pending = null;
  if (!job) return;
  const result = await request(socket, 'maptext:update', { id: job.id, text: job.text });
  saveError.value = result.ok ? '' : reason(result.reason);
}

function onInput() {
  if (!selected.value) return;
  pending = { id: selected.value.id, text: draft.value };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY_MS);
}

function onBlur() {
  flush();
  if (selected.value && !draft.value.trim()) { draft.value = selected.value.text; saveError.value = ''; }
}

// Смена выбора: незаписанное — на сервер (sync: draft ещё прежний), затем поле показывает новую заметку.
watch(() => props.store.selectedId, () => {
  flush();
  saveError.value = '';
  draft.value = selected.value ? selected.value.text : '';
}, { flush: 'sync' });

onBeforeUnmount(() => clearTimeout(saveTimer));

async function focusEditor(select = false) {
  await nextTick();
  if (!editor.value) return;
  editor.value.focus();
  if (select) editor.value.select();
}

// ---- Действия ----
async function addAt(x, y) {
  const result = await request(socket, 'maptext:add', { x, y });
  if (!result.ok) { toast(reason(result.reason), 'error'); return; }
  // Сервер шлёт state раньше ack, поэтому заметка уже в списке: выделяем и сразу даём печатать вместо «Новая заметка».
  mc().selectMapText(result.entry.id);
  draft.value = result.entry.text;
  focusEditor(true);
}

function addHere() {
  const controller = mc();
  if (!controller) return;
  const c = controller.getCameraCenter();
  addAt(c.x, c.y);
}

async function removeNote(id) {
  const result = await request(socket, 'maptext:remove', { id });
  if (!result.ok) toast(reason(result.reason), 'error');
}

async function setField(field, value) {
  if (!selected.value) return;
  const result = await request(socket, 'maptext:update', { id: selected.value.id, [field]: value });
  if (!result.ok) toast(reason(result.reason), 'error');
}

function pick(t) {
  const controller = mc();
  if (!controller) return;
  controller.selectMapText(t.id);
  controller.centerCameraOn(t.x, t.y);
}

// Жесты с канваса (map.js: setMapTextActionHandler → gm.js → сюда): двойной клик и Delete.
function handleAction(a) {
  if (!a) return;
  if (a.action === 'add') addAt(a.x, a.y);
  else if (a.action === 'remove') removeNote(a.id);
  else if (a.action === 'edit') {
    mc().selectMapText(a.id);
    draft.value = selected.value ? selected.value.text : draft.value;
    focusEditor(true);
  }
}
defineExpose({ handleAction });

const firstLine = (t) => (t.text.split('\n')[0] || '').slice(0, 60);
</script>

<template>
  <div class="overlay-body">
    <div class="tab-pane tab-pane-flex active">
      <p class="muted small fog-hint">
        Заметки лежат поверх картинок и видны только вам. Двойной клик по пустому месту — новая заметка, по заметке — правка;
        тащите, чтобы переместить, Delete — удалить. Пока блок открыт, выбор и ход фишек приостановлены.
      </p>
      <button class="fog-btn fog-toggle" @click="addHere"><Icon name="plus" /> Добавить заметку</button>

      <div v-if="selected" class="maptext-edit">
        <label class="form-field">
          <span class="form-field-label">Текст</span>
          <textarea
            ref="editor"
            v-model="draft"
            v-autosize
            rows="3"
            :maxlength="TEXT_MAX"
            placeholder="Текст заметки"
            @input="onInput"
            @blur="onBlur"
          ></textarea>
        </label>
        <div class="maptext-meta muted small">
          <span class="maptext-error">{{ saveError }}</span>
          <span class="maptext-count">{{ draft.length }} / {{ TEXT_MAX }}</span>
        </div>
        <div class="form-field-label">Размер</div>
        <div class="maptext-chips">
          <button
            v-for="s in SIZES"
            :key="s.id"
            type="button"
            class="fog-btn"
            :class="{ active: selected.size === s.id }"
            :aria-pressed="selected.size === s.id"
            :data-tip="s.tip"
            @click="setField('size', s.id)"
          >{{ s.label }}</button>
        </div>
        <div class="form-field-label">Цвет</div>
        <div class="maptext-chips">
          <button
            v-for="c in COLORS"
            :key="c.id"
            type="button"
            class="fog-btn maptext-color"
            :class="{ active: selected.color === c.id }"
            :aria-pressed="selected.color === c.id"
            :aria-label="c.label"
            :data-tip="c.label"
            @click="setField('color', c.id)"
          ><span class="maptext-swatch" :style="{ background: `var(${c.token})` }"></span></button>
        </div>
        <button type="button" class="fog-btn danger maptext-remove" @click="removeNote(selected.id)"><Icon name="trash-2" /> Удалить заметку</button>
      </div>
      <p v-else class="muted small">Выберите заметку на карте или в списке.</p>

      <h4 class="game-heading">Заметки локации · {{ texts.length }}</h4>
      <div class="maptext-list">
        <button
          v-for="t in texts"
          :key="t.id"
          type="button"
          class="maptext-item"
          :class="{ active: selected && selected.id === t.id }"
          @click="pick(t)"
        >
          <span class="maptext-swatch" :style="{ background: `var(--${t.color})` }"></span>
          <span class="maptext-item-text">{{ firstLine(t) }}</span>
          <span class="maptext-item-size muted small">{{ t.size.toUpperCase() }}</span>
        </button>
        <p v-if="!texts.length" class="muted small">На этой локации заметок пока нет.</p>
      </div>
    </div>
  </div>
</template>
