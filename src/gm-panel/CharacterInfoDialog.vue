<script setup>
import { ref, reactive, watch } from 'vue';
import Modal from './Modal.vue';
import Icon from './Icon.vue';
import AvatarEditor from './AvatarEditor.vue';
import { vAutosize } from './autosize.js';
import { useGame } from './useGame';

const props = defineProps({
  character: { type: Object, required: true },
  skillsCatalog: { type: Object, default: () => ({}) },
  avatarPresetUrls: { type: Array, default: () => [] },
  resizeImage: { type: Function, default: null },
});
const emit = defineEmits(['close', 'update', 'code-regenerate', 'remove', 'avatar-preset', 'avatar-upload', 'avatar-clear']);

const name = ref('');
const title = ref('');
const hook = ref('');
const backstory = ref('');
const notes = ref(''); // заметки ГМ о персонаже — игрокам не уходят (getPublicState)
const attrs = reactive({ body: 0, mind: 0, charisma: 0 });
const skills = ref([]);
const { attr, attrIds } = useGame(); // подписи атрибутов — из настроек игры

// Поля инициализируются из character при открытии диалога и при смене героя, но НЕ при каждой
// рассылке state (она подменяет объект героя): иначе любой чужой бросок или смена картинки
// стирали бы набранный, но ещё не сохранённый текст.
watch(
  () => props.character.id,
  () => {
    const c = props.character;
    name.value = c.name || '';
    title.value = c.title || '';
    hook.value = c.hook || '';
    backstory.value = c.backstory || '';
    notes.value = c.notes || '';
    attrIds.forEach((id) => { attrs[id] = c.attributes?.[id] ?? 0; });
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
    notes: notes.value.trim(),
    attributes: { body: Number(attrs.body) || 0, mind: Number(attrs.mind) || 0, charisma: Number(attrs.charisma) || 0 },
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

    <div v-if="resizeImage" class="form-field">
      <span class="form-field-label">Аватар</span>
      <AvatarEditor
        :url="character.avatar || null"
        :name="character.name"
        :color="character.color || '#888888'"
        :presets="avatarPresetUrls"
        :resize-image="resizeImage"
        @preset="(url) => emit('avatar-preset', url)"
        @upload="(dataUrl) => emit('avatar-upload', dataUrl)"
        @clear="emit('avatar-clear')"
      />
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
        <label v-for="id in attrIds" :key="id" class="form-subfield">
          <span class="form-subfield-label">{{ attr(id).label }}</span>
          <input type="number" v-model="attrs[id]">
        </label>
      </div>
    </div>
    <div class="form-field">
      <span class="form-field-label">Завязка</span>
      <textarea rows="2" v-model="hook" v-autosize></textarea>
    </div>
    <div class="form-field">
      <span class="form-field-label">Предыстория</span>
      <textarea rows="3" v-model="backstory" v-autosize></textarea>
    </div>
    <div class="form-field">
      <span class="form-field-label">Заметки <span class="muted small">— видит только ГМ</span></span>
      <textarea rows="3" v-model="notes" placeholder="Что известно мастеру о персонаже, планы, секреты…" v-autosize></textarea>
    </div>

    <div class="form-field">
      <span class="form-field-label">Навыки</span>
      <div class="skills-grid">
        <label v-for="(info, skillName) in skillsCatalog" :key="skillName" class="skill-toggle" :data-tip="info.description || null">
          <input type="checkbox" :checked="skills.includes(skillName)" @change="toggleSkill(skillName)">
          <Icon :name="info.icon" /> {{ skillName }}
        </label>
      </div>
    </div>

    <div class="form-actions">
      <button class="primary" @click="save">Сохранить</button>
      <button class="danger" @click="remove">Удалить</button>
    </div>
  </Modal>
</template>
