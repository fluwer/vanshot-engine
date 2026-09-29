<script setup>
defineProps({
  store: { type: Object, required: true },
});
</script>

<template>
  <div class="overlay-body">
    <div v-for="c in store.characters" :key="c.id" class="party-row">
      <span>{{ c.name }}</span>
      <span class="stat-icon">❤ {{ c.hp.current }}/{{ c.hp.max }}</span>
      <span class="stat-icon">⚡ {{ c.energy.current }}/{{ c.energy.max }}</span>
    </div>
  </div>
</template>
