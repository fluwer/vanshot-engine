<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import Icon from './Icon.vue';
import { useGame } from './useGame';
import { useDock } from './useDock.js';
import { request, reasonText, toast, saveGame, readAsDataUrl } from './gameSettings';

// Вкладка «Звуки и ассеты»: звуки интерфейса (бросок кубика, начало боя, заставка локации), показ
// поставляемых с движком примеров (музыка, звуки, готовые аватары) и свои готовые картинки героев.
// Музыку и звуки саундборда загружают в блоке «Звук». Файлы лежат в server/data/ (том Docker).
const props = defineProps({ bridge: { type: Object, required: true } });

const { config } = useGame();
const dock = useDock();

const SLOTS = [
  { kind: 'diceRoll', label: 'Бросок кубика', hint: 'Звучит на каждый бросок на экране у всех' },
  { kind: 'combatStart', label: 'Начало боя', hint: 'Звучит при заставке «Инициатива!»' },
  { kind: 'sceneEnter', label: 'Заставка локации', hint: 'Звучит при входе в новую локацию. Без файла играет синтезированный звук' },
];
const SFX_MAX_BYTES = 1024 * 1024;

const sfx = (kind) => (config.value.sfx || {})[kind] || null;
const volumeOf = (kind) => { const s = sfx(kind); return s ? s.volume : 1; };
const fileLabel = (kind) => {
  const s = sfx(kind);
  return s ? decodeURIComponent(s.url.split('/').pop()) : 'стандартный';
};

function play(kind) {
  const s = window.Game.sfx(kind);
  const a = new Audio(s.url);
  a.volume = Math.min(1, 0.6 * s.volume);
  a.play().catch(() => toast('Звук не воспроизвёлся: файла нет или браузер не разрешил звук', 'error'));
}

async function upload(kind, event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > SFX_MAX_BYTES) {
    toast('Звук слишком большой: не больше 1 МБ (mp3, ogg или wav)', 'error');
    return;
  }
  let dataUrl;
  try {
    dataUrl = await readAsDataUrl(file);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const result = await request(props.bridge.socket, 'sfx:upload', { kind, dataUrl });
  if (!result.ok) toast(reasonText(result.reason), 'error');
  else toast('Звук заменён', 'info');
}

async function reset(kind) {
  const result = await request(props.bridge.socket, 'sfx:reset', { kind });
  if (!result.ok) toast(reasonText(result.reason), 'error');
}

// Громкость относительная (1 = как задумано в стандартном звуке); применяется, когда ГМ отпустил ползунок.
async function setVolume(kind, value) {
  const s = window.Game.sfx(kind);
  await saveGame(props.bridge.socket, { sfx: { [kind]: { url: s.url, volume: Number(value) } } }, '');
}

// ---- Поставляемые примеры ----
const showBundled = computed(() => config.value.showBundled !== false);
async function toggleBundled(on) {
  const ok = await saveGame(props.bridge.socket, { showBundled: !!on }, '');
  if (ok) loadPresets();
}

// ---- Готовые картинки героев ----
const presets = ref([]);
async function loadPresets() {
  try {
    const r = await fetch('/avatars/presets/manifest.json', { cache: 'no-store' });
    presets.value = r.ok ? await r.json() : [];
  } catch (err) {
    presets.value = [];
  }
  props.bridge.refreshPresets?.(); // окна героев/NPC берут список у моста gm.js
}
onMounted(loadPresets);
watch(() => dock.current.value === 'game', (open) => { if (open) loadPresets(); });

function uploadPreset(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const name = file.name.replace(/\.[^.]+$/, '').slice(0, 40);
  props.bridge.resizeImage(file, 128, async (dataUrl) => {
    const result = await request(props.bridge.socket, 'preset:upload', { name, dataUrl });
    if (!result.ok) toast(reasonText(result.reason), 'error');
    else { toast('Картинка добавлена', 'info'); loadPresets(); }
  });
}

async function removePreset(p) {
  if (!confirm(`Удалить картинку «${p.label}»? У героев и NPC, которым она назначена, останется буква-заглушка.`)) return;
  const result = await request(props.bridge.socket, 'preset:remove', { url: p.url });
  if (!result.ok) toast(reasonText(result.reason), 'error');
  else loadPresets();
}
</script>

<template>
  <div class="game-tab">
    <h4 class="game-heading">Звуки интерфейса</h4>
    <div v-for="s in SLOTS" :key="s.kind" class="game-sfx" :data-tip="s.hint">
      <div class="game-row">
        <span class="game-row-label">{{ s.label }}</span>
        <button type="button" class="small" data-tip="Проиграть" :aria-label="`Проиграть: ${s.label}`" @click="play(s.kind)"><Icon name="play" /></button>
        <label class="upload-label upload-inline game-upload" data-tip="mp3, ogg или wav, до 1 МБ">
          <Icon name="upload" /> Загрузить
          <input type="file" accept="audio/mpeg,audio/ogg,audio/wav,audio/x-wav" hidden @change="upload(s.kind, $event)">
        </label>
        <button type="button" class="small" :disabled="!sfx(s.kind)" data-tip="Вернуть стандартный звук" :aria-label="`Вернуть стандартный звук: ${s.label}`" @click="reset(s.kind)"><Icon name="rotate-ccw" /></button>
      </div>
      <div class="game-row game-sfx-sub">
        <span class="muted small game-sfx-file">{{ fileLabel(s.kind) }}</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          class="game-sfx-volume"
          :value="volumeOf(s.kind)"
          :aria-label="`Громкость: ${s.label}`"
          @change="setVolume(s.kind, $event.target.value)"
        >
      </div>
    </div>

    <h4 class="game-heading">Примеры из образа</h4>
    <label class="game-check">
      <input type="checkbox" :checked="showBundled" @change="toggleBundled($event.target.checked)">
      Показывать музыку, звуки и готовые аватары, которые поставляются с движком
    </label>
    <p class="muted small game-hint">Выключите для новой игры: в списках останется только то, что загрузили вы. Уже назначенные картинки героев продолжают работать.</p>

    <h4 class="game-heading">Готовые картинки героев</h4>
    <div class="game-presets">
      <div v-for="p in presets" :key="p.url" class="game-preset" :class="{ own: p.own }">
        <img :src="p.url" :alt="p.label" loading="lazy">
        <span class="game-preset-label" :title="p.label">{{ p.label }}</span>
        <button v-if="p.own" type="button" class="small game-preset-del" data-tip="Удалить" :aria-label="`Удалить картинку ${p.label}`" @click="removePreset(p)"><Icon name="trash-2" /></button>
      </div>
      <p v-if="!presets.length" class="muted small">Готовых картинок нет — загрузите свои.</p>
    </div>
    <label class="upload-label upload-inline game-upload">
      <Icon name="upload" /> Добавить картинку
      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden @change="uploadPreset">
    </label>
    <p class="muted small game-hint">Картинка обрежется до квадрата 128×128 (по центру, чуть выше — для лиц). Назначить её герою или NPC — в их окне «Инфо».</p>
  </div>
</template>
