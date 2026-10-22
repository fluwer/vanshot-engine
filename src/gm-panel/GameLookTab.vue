<script setup>
import { reactive, computed, watch } from 'vue';
import Icon from './Icon.vue';
import { useGame } from './useGame';
import { useDock } from './useDock.js';
import { saveGame, resetGame, request, reasonText, toast } from './gameSettings';

// Вкладка «Оформление»: название игры, подзаголовок (заголовок формы входа игроков) и четыре цвета
// темы. Цвета видны сразу (предпросмотр только у ГМ, Game.previewTheme) и уходят всем после «Сохранить».
// Пустой цвет (null) = как в tokens.css; остальные оттенки интерфейса выводятся из этих четырёх.
const props = defineProps({ bridge: { type: Object, required: true } });

const { config } = useGame();
const dock = useDock();
const defaults = window.Game.THEME_DEFAULTS;

const COLORS = [
  { key: 'bg', label: 'Фон и панели', hint: 'Базовый тёмный тон: из него выводятся панели, карточки, линии. Светлые фоны не рассчитаны.' },
  { key: 'text', label: 'Текст', hint: 'Основной цвет текста; приглушённые оттенки выводятся из него.' },
  { key: 'accent', label: 'Акцент', hint: 'Выбранные кнопки, ссылки, активные вкладки, иней в погоде.' },
  { key: 'amber', label: 'Янтарь', hint: 'Текущий ход, линейка, бонусные подсказки.' },
];

const draft = reactive({ title: '', subtitle: '', theme: { bg: null, text: null, accent: null, amber: null } });

function load() {
  const c = config.value;
  draft.title = c.title || '';
  draft.subtitle = c.subtitle || '';
  COLORS.forEach(({ key }) => { draft.theme[key] = (c.theme || {})[key] || null; });
}
watch(config, load, { immediate: true });

// Ушли с экрана «Игра» (закрыли блок, выбрали другой пункт) — несохранённое отбрасываем вместе с предпросмотром.
watch(() => dock.current.value !== 'game', (away) => {
  if (!away) return;
  load();
  window.Game.clearPreview();
});

const dirty = computed(() => {
  const c = config.value;
  if (draft.title.trim() !== (c.title || '') || draft.subtitle.trim() !== (c.subtitle || '')) return true;
  return COLORS.some(({ key }) => (draft.theme[key] || null) !== ((c.theme || {})[key] || null));
});

const colorValue = (key) => draft.theme[key] || defaults[key];

function onColor(key, value) {
  draft.theme[key] = value;
  window.Game.previewTheme({ ...draft.theme });
}
function colorDefault(key) {
  draft.theme[key] = null;
  window.Game.previewTheme({ ...draft.theme });
}

async function save() {
  const ok = await saveGame(props.bridge.socket, {
    title: draft.title.trim(),
    subtitle: draft.subtitle.trim(),
    theme: { ...draft.theme },
  });
  if (ok) window.Game.clearPreview(); // сохранённое теперь приходит в state.game и применяется как обычно
}

function cancel() {
  load();
  window.Game.clearPreview();
}

// ---- Картинка окна входа игроков ----
// Меняется сразу (как звуки интерфейса), без «Сохранить»: файл уходит отдельным событием, адрес приходит
// всем в state.game.loginImage — открытые окна входа обновляются сами.
const loginImage = computed(() => (config.value && config.value.loginImage) || null);
const LOGIN_REASONS = {
  'bad-format': 'Неподходящий формат: нужна картинка PNG, JPEG, WebP или GIF',
  'too-large': 'Картинка слишком большая: не больше 3 МБ',
};
const loginReason = (reason) => LOGIN_REASONS[reason] || reasonText(reason);

async function uploadLoginImage(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  let dataUrl;
  try {
    dataUrl = await window.imageTools.loginImageFromFile(file);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const result = await request(props.bridge.socket, 'loginimg:upload', { dataUrl }, 20000);
  if (!result.ok) toast(loginReason(result.reason), 'error');
  else toast('Картинка окна входа заменена', 'info');
}

async function removeLoginImage() {
  const result = await request(props.bridge.socket, 'loginimg:reset', {});
  if (!result.ok) toast(loginReason(result.reason), 'error');
}

async function toExample() {
  if (!confirm('Вернуть название, подзаголовок и цвета, как в примере игры?')) return;
  window.Game.clearPreview();
  const socket = props.bridge.socket;
  const a = await resetGame(socket, 'title', '');
  const b = await resetGame(socket, 'subtitle', '');
  const c = await resetGame(socket, 'theme', '');
  if (a && b && c) window.imageTools.notify('Оформление возвращено к примеру', 'info');
}
</script>

<template>
  <div class="game-tab">
    <div class="form-field">
      <span class="form-field-label">Название игры</span>
      <input v-model="draft.title" maxlength="60" placeholder="Название">
      <span class="muted small">Заголовок вкладки браузера.</span>
    </div>
    <div class="form-field">
      <span class="form-field-label">Подзаголовок</span>
      <input v-model="draft.subtitle" maxlength="80" placeholder="Например: название приключения">
      <span class="muted small">Заголовок формы входа игроков («… — вход»). Пусто — берётся название.</span>
    </div>

    <h4 class="game-heading">Цвета</h4>
    <div v-for="c in COLORS" :key="c.key" class="game-row game-color-row" :data-tip="c.hint">
      <input
        type="color"
        class="game-color"
        :value="colorValue(c.key)"
        :aria-label="c.label"
        @input="onColor(c.key, $event.target.value)"
      >
      <span class="game-row-label">{{ c.label }}</span>
      <code class="muted small">{{ draft.theme[c.key] || 'по умолчанию' }}</code>
      <button
        type="button"
        class="small game-row-end"
        :disabled="!draft.theme[c.key]"
        data-tip="Вернуть цвет по умолчанию"
        aria-label="Вернуть цвет по умолчанию"
        @click="colorDefault(c.key)"
      ><Icon name="rotate-ccw" /></button>
    </div>

    <div class="form-actions">
      <button class="primary" :disabled="!dirty" @click="save"><Icon name="save" /> Сохранить</button>
      <button :disabled="!dirty" @click="cancel">Отмена</button>
    </div>
    <button type="button" class="small game-reset" @click="toExample">Вернуть оформление как в примере</button>

    <h4 class="game-heading">Картинка окна входа</h4>
    <div class="login-art-edit">
      <div class="login-art-preview" :class="{ empty: !loginImage }">
        <img v-if="loginImage" :src="loginImage.url" alt="Картинка окна входа">
        <span v-else class="muted small">Нет картинки</span>
      </div>
      <div class="login-art-actions">
        <label class="upload-label upload-inline game-upload" data-tip="PNG, JPEG, WebP или GIF; сожмётся до 1280 px">
          <Icon name="upload" /> {{ loginImage ? 'Заменить' : 'Загрузить' }}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden @change="uploadLoginImage">
        </label>
        <button type="button" class="small" :disabled="!loginImage" data-tip="Убрать картинку" aria-label="Убрать картинку окна входа" @click="removeLoginImage"><Icon name="trash-2" /> Убрать</button>
      </div>
    </div>
    <p class="muted small game-hint">Показывается справа от полей в окне входа игроков: заполняет рамку по центру, лишнее по краям обрезается (превью — примерно как будет). Меняется сразу, без «Сохранить». Нет картинки — окно входа остаётся в одну колонку.</p>
  </div>
</template>
