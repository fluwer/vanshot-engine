<script setup>
import { ref, computed } from 'vue';
import Icon from './Icon.vue';

// Выбор иконки из реестра public/js/icons.js: кнопка с текущей иконкой раскрывает сетку с поиском по
// имени. Сетка раскрывается в потоке (а не всплывающим окном) — блок Dock обрезает всё, что выходит за
// его края; поэтому корень — display: contents, а родительская строка должна быть flex с переносом
// (.game-row): сетка занимает всю ширину строки под кнопкой.
const props = defineProps({
  modelValue: { type: String, default: '' },
  label: { type: String, default: 'Иконка' },
});
const emit = defineEmits(['update:modelValue']);

const open = ref(false);
const query = ref('');

const names = computed(() => {
  const all = (window.Icons && window.Icons.names()) || [];
  const q = query.value.trim().toLowerCase();
  // faction-* — формы значков фракций на карте: выбираются не здесь, а закреплены за фракциями.
  return all.filter((n) => !n.startsWith('faction-') && (!q || n.includes(q)));
});

function pick(name) {
  emit('update:modelValue', name);
  open.value = false;
  query.value = '';
}
</script>

<template>
  <div class="icon-picker">
    <button
      type="button"
      class="icon-picker-btn"
      :data-tip="`${label}: ${modelValue || '—'}`"
      :aria-label="`${label}: ${modelValue || 'не выбрана'}`"
      :aria-expanded="open"
      @click="open = !open"
    ><Icon :name="modelValue || 'diamond'" /></button>
    <div v-if="open" class="icon-picker-pop">
      <input v-model="query" class="icon-picker-search" placeholder="Поиск по имени: sword, heart, pickaxe…" autocomplete="off">
      <div class="icon-picker-grid">
        <button
          v-for="n in names"
          :key="n"
          type="button"
          class="icon-picker-cell"
          :class="{ active: n === modelValue }"
          :data-tip="n"
          :aria-label="n"
          @click="pick(n)"
        ><Icon :name="n" /></button>
      </div>
      <p v-if="!names.length" class="muted small">Ничего не найдено</p>
    </div>
  </div>
</template>
