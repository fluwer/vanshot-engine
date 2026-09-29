<script setup>
import { ref } from 'vue';

defineProps({ items: { type: Array, default: () => [] } });
const emit = defineEmits(['give', 'remove']);

const newItem = ref('');
function give() {
  const trimmed = newItem.value.trim();
  if (!trimmed) return;
  emit('give', trimmed);
  newItem.value = '';
}
</script>

<template>
  <div class="gm-inventory">
    <span class="muted small">Инвентарь:</span>
    <div class="gm-item-list">
      <template v-if="items.length">
        <span class="gm-item" v-for="(item, i) in items" :key="i">
          {{ item }}<button class="gm-item-x" @click="emit('remove', i)">✕</button>
        </span>
      </template>
      <span v-else class="muted small">пусто</span>
    </div>
    <div class="row" style="gap:4px">
      <input class="gm-item-input" v-model="newItem" placeholder="выдать предмет…" @keydown.enter="give">
      <button class="small gm-item-give" @click="give">+</button>
    </div>
  </div>
</template>
