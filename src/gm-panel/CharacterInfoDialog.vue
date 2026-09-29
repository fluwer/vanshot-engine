<script setup>
import { ref, watch } from 'vue';
import Modal from './Modal.vue';

const props = defineProps({
  character: { type: Object, required: true },
  skillsCatalog: { type: Object, default: () => ({}) },
});
const emit = defineEmits(['close', 'update', 'code-regenerate', 'remove']);

const name = ref('');
const title = ref('');
const hook = ref('');
const backstory = ref('');
const body = ref(0);
const mind = ref(0);
const charisma = ref(0);
const skills = ref([]);

// Поля инициализируются из character при каждом открытии диалога (переоткрытие
// на другом персонаже — новый v-if-инстанс, watch с immediate — на случай
// живого обновления character, пока диалог открыт).
watch(
  () => props.character,
  (c) => {
    name.value = c.name || '';
    title.value = c.title || '';
    hook.value = c.hook || '';
    backstory.value = c.backstory || '';
    body.value = c.attributes?.body ?? 0;
    mind.value = c.attributes?.mind ?? 0;
    charisma.value = c.attributes?.charisma ?? 0;
    skills.value = [...(c.skills || [])];
  },
  { immediate: true },
);

function toggleSkill(skillName) {
  const idx = skills.value.indexOf(skillName);
  if (idx === -1) skills.value.push(skillName);
  else skills.value.splice(idx, 1);
}

function save() {
  emit('update', {
    name: name.value.trim(),
    title: title.value.trim(),
    hook: hook.value.trim(),
    backstory: backstory.value.trim(),
    attributes: { body: Number(body.value) || 0, mind: Number(mind.value) || 0, charisma: Number(charisma.value) || 0 },
    skills: skills.value,
  });
  emit('close');
}

function remove() {
  if (!confirm('Удалить персонажа безвозвратно?')) return;
  emit('remove');
  emit('close');
}
</script>

<template>
  <Modal @close="emit('close')">
    <template #title>Персонаж: {{ character.name }}</template>

    <div class="row gm-stat-row">
      <span class="stat-label-sm">Код</span>
      <span class="stat-value char-code">{{ character.code || '—' }}</span>
      <button class="small char-code-regen" @click="emit('code-regenerate')">Новый код</button>
    </div>

    <div class="form-field">
      <span class="form-field-label">Имя</span>
      <input v-model="name">
    </div>
    <div class="form-field">
      <span class="form-field-label">Титул</span>
      <input v-model="title">
    </div>
    <div class="form-field">
      <span class="form-field-label">Атрибуты</span>
      <div class="form-row">
        <label class="form-subfield">
          <span class="form-subfield-label">Тело</span>
          <input type="number" v-model="body">
        </label>
        <label class="form-subfield">
          <span class="form-subfield-label">Разум</span>
          <input type="number" v-model="mind">
        </label>
        <label class="form-subfield">
          <span class="form-subfield-label">Харизма</span>
          <input type="number" v-model="charisma">
        </label>
      </div>
    </div>
    <div class="form-field">
      <span class="form-field-label">Завязка</span>
      <textarea rows="2" v-model="hook"></textarea>
    </div>
    <div class="form-field">
      <span class="form-field-label">Предыстория</span>
      <textarea rows="3" v-model="backstory"></textarea>
    </div>

    <div class="form-field">
      <span class="form-field-label">Навыки</span>
      <div class="skills-grid">
        <label v-for="(info, skillName) in skillsCatalog" :key="skillName" class="skill-toggle">
          <input type="checkbox" :checked="skills.includes(skillName)" @change="toggleSkill(skillName)">
          {{ info.icon }} {{ skillName }}
        </label>
      </div>
    </div>

    <div class="form-actions">
      <button @click="save">Сохранить</button>
      <button class="danger" @click="remove">Удалить</button>
    </div>
  </Modal>
</template>
