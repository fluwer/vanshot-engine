<script setup>
import { ref, reactive, watch } from 'vue';
import Modal from './Modal.vue';
import AvatarEditor from './AvatarEditor.vue';
import { vAutosize } from './autosize.js';
import { useGame } from './useGame';

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
const attrs = reactive({ body: 0, mind: 0, charisma: 0 });
const { attr, attrIds } = useGame(); // подписи атрибутов — из настроек игры

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
    attrIds.forEach((id) => { attrs[id] = n.attributes?.[id] ?? 0; });
  },
  { immediate: true },
);

function save() {
  emit('update', {
    name: name.value.trim(),
    role: role.value.trim(),
    notes: notes.value.trim(),
    secret: secret.value.trim(),
    attributes: { body: Number(attrs.body) || 0, mind: Number(attrs.mind) || 0, charisma: Number(attrs.charisma) || 0 },
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
        <label v-for="id in attrIds" :key="id" class="form-subfield">
          <span class="form-subfield-label">{{ attr(id).label }}</span>
          <input type="number" v-model="attrs[id]">
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
