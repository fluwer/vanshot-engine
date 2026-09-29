<script setup>
// Общая строка ресурса (HP/энергия/решимость) с полоской или простое
// числовое значение (броня) — заменяет 3-4 почти идентичных блока,
// которые раньше дублировались в renderCharacters/renderNpcs.
defineProps({
  label: { type: String, required: true },
  current: { type: Number, required: true },
  max: { type: Number, default: null },
  barClass: { type: String, default: '' },
  mode: { type: String, default: 'bar' }, // 'bar' | 'value'
});
const emit = defineEmits(['delta']);
</script>

<template>
  <div class="row gm-stat-row">
    <span class="stat-label-sm">{{ label }}</span>
    <template v-if="mode === 'bar'">
      <div class="bar-track">
        <div class="bar-fill" :class="barClass" :style="{ width: (current / max) * 100 + '%' }"></div>
      </div>
      <span class="stat-value">{{ current }}/{{ max }}</span>
    </template>
    <template v-else>
      <span class="stat-value">{{ current }}</span>
    </template>
    <button class="small" @click="emit('delta', -1)">-1</button>
    <button class="small" @click="emit('delta', 1)">+1</button>
  </div>
</template>
