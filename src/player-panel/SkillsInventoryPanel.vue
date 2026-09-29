<script setup>
import { computed } from 'vue';

const props = defineProps({
  store: { type: Object, required: true },
});

const character = computed(() => props.store.characters.find((c) => c.id === props.store.myCharacterId));

function skillInfo(skill) {
  const catalog = props.store.skillsCatalog;
  return (catalog && catalog[skill]) || { icon: '•', description: '' };
}
</script>

<template>
  <template v-if="character">
    <h3>Навыки</h3>
    <div class="skills-list">
      <div v-for="skill in character.skills || []" :key="skill" class="skill-row">
        <span class="skill-icon">{{ skillInfo(skill).icon }}</span>
        <div>
          <div class="skill-name">{{ skill }}</div>
          <div class="skill-desc muted">{{ skillInfo(skill).description }}</div>
        </div>
      </div>
    </div>
    <h3>Инвентарь</h3>
    <div class="inventory-list">
      <div v-if="!character.inventory || !character.inventory.length" class="muted small">Пусто</div>
      <span v-for="(item, i) in character.inventory" :key="i" class="item-chip">{{ item }}</span>
    </div>
  </template>
</template>
