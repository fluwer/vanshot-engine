<script setup>
import { ref, watch } from 'vue';
import Modal from './Modal.vue';
import AvatarEditor from './AvatarEditor.vue';
import { vAutosize } from './autosize.js';

const props = defineProps({
  npc: { type: Object, required: true },
  avatarPresetUrls: { type: Array, default: () => [] },
  resizeImage: { type: Function, required: true },
});
const emit = defineEmits(['close', 'update', 'avatar-preset', 'avatar-upload', 'avatar-clear', 'remove']);

const name = ref('');
const role = ref('');
const notes = ref('');
const secret = ref('');
const body = ref(0);
const mind = ref(0);
const charisma = ref(0);

// Поля — из NPC при открытии диалога (не при каждой рассылке state: она подменяет объект NPC, и
// смена картинки или чужой бросок стирали бы набранный, но не сохранённый текст).
watch(
  () => props.npc.id,
  () => {
    const n = props.npc;
    name.value = n.name || '';
    role.value = n.role || '';
    notes.value = n.notes || '';
    secret.value = n.secret || '';
    body.value = n.attributes?.body ?? 0;
    mind.value = n.attributes?.mind ?? 0;
    charisma.value = n.attributes?.charisma ?? 0;
  },
  { immediate: true },
);

function save() {
  emit('update', {
    name: name.value.trim(),
    role: role.value.trim(),
    notes: notes.value.trim(),
    secret: secret.value.trim(),
    attributes: { body: Number(body.value) || 0, mind: Number(mind.value) || 0, charisma: Number(charisma.value) || 0 },
  });
  emit('close');
}

function remove() {
  if (!confirm('Удалить NPC безвозвратно?')) return;
  emit('remove');
  emit('close');
}
</script>

<template>
  <Modal @close="emit('close')">
    <template #title>NPC: {{ npc.name }}</template>

    <div class="form-field">
      <span class="form-field-label">Аватар</span>
      <AvatarEditor
        :url="npc.avatar || null"
        :name="npc.name"
        color="#c05656"
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
      <span class="form-field-label">Роль</span>
      <input v-model="role">
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
      <span class="form-field-label">Заметки</span>
      <textarea rows="2" v-model="notes" v-autosize></textarea>
    </div>
    <div class="form-field">
      <span class="form-field-label">Секрет</span>
      <textarea rows="2" v-model="secret" v-autosize></textarea>
    </div>

    <div class="form-actions">
      <button class="primary" @click="save">Сохранить</button>
      <button class="danger" @click="remove">Удалить</button>
    </div>
  </Modal>
</template>
