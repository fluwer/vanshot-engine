<script setup>
import { computed } from 'vue';
import Icon from './Icon.vue';

// Слой и положение выбранной картинки на карте: порядок слоёв, поворот на 90°, отражение.
// Общий для ГМ (MapToolsPanel) и игрока (MyImagesPanel, своя картинка); права проверяет сервер
// (index.js: mapimage:reorder / mapimage:update), здесь — только доступность кнопок.
// Порядок слоёв — порядок картинок в state.mapImages: первая — самая нижняя.
const props = defineProps({
  image: { type: Object, default: null },
  stack: { type: Array, default: () => [] }, // все картинки активной локации снизу вверх
  bridge: { type: Object, required: true },
  gm: { type: Boolean, default: false },
});

const index = computed(() => (props.image ? props.stack.findIndex((m) => m.id === props.image.id) : -1));
const atTop = computed(() => index.value === props.stack.length - 1);
const atBottom = computed(() => index.value === 0);
const locked = computed(() => !!(props.image && props.image.locked));
// Блокировка ГМ запрещает правку игроку целиком; у самого ГМ она держит положение, поэтому слои
// он двигать может, а поворачивать и отражать заблокированную картинку — нет (как и ручками на карте).
const layerOff = computed(() => index.value === -1 || (!props.gm && locked.value));
const geometryOff = computed(() => index.value === -1 || locked.value);

const FAIL_TEXT = {
  locked: 'ГМ заблокировал картинку',
  forbidden: 'Это не ваша картинка',
  'wrong-location': 'Картинка на другой локации',
};
function onAck(res) {
  if (res && !res.ok && res.reason !== 'rate-limit') {
    window.imageTools?.notify(FAIL_TEXT[res.reason] || 'Не удалось изменить картинку', 'error');
  }
}

function reorder(op) {
  props.bridge.socket.emit('mapimage:reorder', { id: props.image.id, op }, onAck);
}

function update(patch) {
  props.bridge.socket.emit('mapimage:update', { id: props.image.id, ...patch }, onAck);
}

const FULL_TURN = Math.PI * 2;
function rotate90() {
  update({ rotation: ((props.image.rotation || 0) + Math.PI / 2) % FULL_TURN });
}
</script>

<template>
  <div class="image-tools">
    <span class="fog-label">Слой</span>
    <div class="image-tools-row">
      <button type="button" class="small" :disabled="layerOff || atTop" data-tip="На передний план" aria-label="На передний план" @click="reorder('front')"><Icon name="bring-to-front" /></button>
      <button type="button" class="small" :disabled="layerOff || atTop" data-tip="Выше на один слой" aria-label="Выше на один слой" @click="reorder('up')"><Icon name="arrow-up" /></button>
      <button type="button" class="small" :disabled="layerOff || atBottom" data-tip="Ниже на один слой" aria-label="Ниже на один слой" @click="reorder('down')"><Icon name="arrow-down" /></button>
      <button type="button" class="small" :disabled="layerOff || atBottom" data-tip="На задний план" aria-label="На задний план" @click="reorder('back')"><Icon name="send-to-back" /></button>
    </div>
    <span class="fog-label">Поворот и отражение</span>
    <div class="image-tools-row image-tools-row-3">
      <button type="button" class="small" :disabled="geometryOff" data-tip="Повернуть на 90° по часовой" aria-label="Повернуть на 90°" @click="rotate90"><Icon name="rotate-cw" /></button>
      <button type="button" class="small" :class="{ active: image && image.flipX }" :disabled="geometryOff" data-tip="Отразить по горизонтали" aria-label="Отразить по горизонтали" @click="update({ flipX: !image.flipX })"><Icon name="flip-horizontal-2" /></button>
      <button type="button" class="small" :class="{ active: image && image.flipY }" :disabled="geometryOff" data-tip="Отразить по вертикали" aria-label="Отразить по вертикали" @click="update({ flipY: !image.flipY })"><Icon name="flip-vertical-2" /></button>
    </div>
  </div>
</template>
