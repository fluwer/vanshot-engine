<script setup>
import { onMounted, onUnmounted } from 'vue';
import Icon from './Icon.vue';

const emit = defineEmits(['close']);

function onKeydown(e) {
  if (e.key === 'Escape') emit('close');
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onUnmounted(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="emit('close')">
      <div class="card modal-dialog">
        <div class="modal-dialog-head">
          <h2><slot name="title"></slot></h2>
          <button class="small" title="Закрыть" aria-label="Закрыть" @click="emit('close')"><Icon name="x" /></button>
        </div>
        <slot></slot>
      </div>
    </div>
  </Teleport>
</template>
