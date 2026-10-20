<script setup>
import { ref, reactive } from 'vue';
import { useGame } from './useGame';

const props = defineProps({ kind: { type: String, required: true } }); // 'character' | 'npc'
const emit = defineEmits(['submit', 'cancel']);

// Подписи атрибутов и ресурсов — из настроек игры.
const { attr, res, attrIds } = useGame();

const name = ref('');
const role = ref('');
const attrs = reactive({ body: 0, mind: 0, charisma: 0 });
const hpMax = ref(10);
const energyMax = ref(6);
const resolveMax = ref(3);

function submit() {
  const trimmedName = name.value.trim();
  if (!trimmedName) return;
  const data = {
    name: trimmedName,
    attributes: { body: Number(attrs.body) || 0, mind: Number(attrs.mind) || 0, charisma: Number(attrs.charisma) || 0 },
    hp: Number(hpMax.value) || 10,
    energy: Number(energyMax.value) || 6,
  };
  if (props.kind === 'character') {
    data.resolve = Number(resolveMax.value) || 3;
  } else {
    data.role = role.value.trim() || 'NPC';
  }
  emit('submit', data);
  name.value = '';
  role.value = '';
  attrIds.forEach((id) => { attrs[id] = 0; });
  hpMax.value = 10;
  energyMax.value = 6;
  resolveMax.value = 3;
}
</script>

<template>
  <div class="card compact add-entity-form">
    <div class="form-field">
      <span class="form-field-label">Имя</span>
      <input v-model="name" placeholder="Имя">
    </div>
    <div v-if="kind === 'npc'" class="form-field">
      <span class="form-field-label">Роль</span>
      <input v-model="role" placeholder="Роль/описание">
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
      <span class="form-field-label">Ресурсы</span>
      <div class="form-row">
        <label class="form-subfield">
          <span class="form-subfield-label">{{ res('hp').label }}</span>
          <input type="number" min="1" v-model="hpMax">
        </label>
        <label class="form-subfield">
          <span class="form-subfield-label">{{ res('energy').label }}</span>
          <input type="number" min="1" v-model="energyMax">
        </label>
        <label v-if="kind === 'character'" class="form-subfield">
          <span class="form-subfield-label">{{ res('resolve').label }}</span>
          <input type="number" min="1" v-model="resolveMax">
        </label>
      </div>
    </div>
    <div class="form-actions">
      <button class="primary" @click="submit">Добавить</button>
      <button @click="emit('cancel')">Отмена</button>
    </div>
  </div>
</template>
