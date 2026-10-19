<script setup>
import Icon from './Icon.vue';

// Блок «Аватар» в окнах героя и NPC (ГМ): превью, миниатюры готовых картинок из
// public/avatars/presets (список строит сервер по содержимому папки), «Загрузить файл» и «Убрать».
// Состояние не хранит: всё уходит событиями наверх, а превью обновляется от живых данных героя/NPC.
// Загруженный файл обрезается до квадрата 128×128 PNG (bridge.resizeImage → imageTools.avatarFromFile).
const props = defineProps({
  url: { type: String, default: null },       // текущая картинка (null — заглушка-буква)
  name: { type: String, default: '' },
  color: { type: String, default: '#888888' }, // цвет буквы-заглушки (героя / фракции NPC)
  presets: { type: Array, default: () => [] }, // URL готовых картинок
  resizeImage: { type: Function, required: true },
});
const emit = defineEmits(['preset', 'upload', 'clear']);

function onFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (file) props.resizeImage(file, 128, (dataUrl) => emit('upload', dataUrl));
}

const presetTip = (url) => decodeURIComponent(url.split('/').pop().replace(/\.[^.]+$/, '')).replace(/[-_]+/g, ' ');
</script>

<template>
  <div class="avatar-edit">
    <div class="avatar-edit-head">
      <img v-if="url" class="avatar-edit-preview" :src="url" alt="">
      <span v-else class="avatar-edit-preview avatar-edit-fallback" :style="{ background: color }">{{ (name || '?')[0] }}</span>
      <div class="avatar-edit-actions">
        <label class="upload-label upload-inline"><Icon name="upload" /> Загрузить файл<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden @change="onFile"></label>
        <button v-if="url" type="button" class="small" @click="emit('clear')"><Icon name="x" /> Убрать</button>
      </div>
    </div>
    <div v-if="presets.length" class="avatar-edit-presets">
      <img
        v-for="p in presets"
        :key="p"
        class="npc-avatar-preset"
        :class="{ selected: p === url }"
        :src="p"
        :data-tip="presetTip(p)"
        alt=""
        @click="emit('preset', p)"
      >
    </div>
  </div>
</template>
