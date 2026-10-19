<script setup>
import { ref } from 'vue';
import Icon from '../gm-panel/Icon.vue';

defineProps({
  store: { type: Object, required: true },
});

// Компактная карточка «Отряд» справа сверху: имя + ❤/⚡ каждого. Сворачивается по
// клику по заголовку; выбор запоминаем (как и колонку ГМ — ключ с префиксом dock:).
const COLLAPSE_KEY = 'dock:party';
function loadCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch (err) {
    return false;
  }
}
const collapsed = ref(loadCollapsed());
function toggle() {
  collapsed.value = !collapsed.value;
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed.value ? '1' : '0');
  } catch (err) {
    // приватный режим / заблокированное хранилище — просто не запоминаем
  }
}
</script>

<template>
  <div class="party-card">
    <button type="button" class="party-card-head" :title="collapsed ? 'Показать отряд' : 'Свернуть отряд'" @click="toggle">
      <span>Отряд</span>
      <Icon :name="collapsed ? 'chevron-right' : 'chevron-down'" />
    </button>
    <template v-if="!collapsed">
      <div v-for="c in store.characters" :key="c.id" class="party-row">
        <span>{{ c.name }}</span>
        <span class="stat-icon"><Icon name="heart" class="ico-hp" /> {{ c.hp.current }}/{{ c.hp.max }}</span>
        <span class="stat-icon"><Icon name="zap" class="ico-energy" /> {{ c.energy.current }}/{{ c.energy.max }}</span>
      </div>
    </template>
  </div>
</template>
