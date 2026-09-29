<script setup>
import { ref } from 'vue';

const props = defineProps({ kind: { type: String, required: true } }); // 'character' | 'npc'
const emit = defineEmits(['submit', 'cancel']);

const name = ref('');
const role = ref('');
const body = ref(0);
const mind = ref(0);
const charisma = ref(0);
const hpMax = ref(10);
const energyMax = ref(6);
const resolveMax = ref(3);

function submit() {
  const trimmedName = name.value.trim();
  if (!trimmedName) return;
  const data = {
    name: trimmedName,
    attributes: { body: Number(body.value) || 0, mind: Number(mind.value) || 0, charisma: Number(charisma.value) || 0 },
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
  body.value = 0;
  mind.value = 0;
  charisma.value = 0;
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
      <span class="form-field-label">Ресурсы</span>
      <div class="form-row">
        <label class="form-subfield">
          <span class="form-subfield-label">HP</span>
          <input type="number" min="1" v-model="hpMax">
        </label>
        <label class="form-subfield">
          <span class="form-subfield-label">Энергия</span>
          <input type="number" min="1" v-model="energyMax">
        </label>
        <label v-if="kind === 'character'" class="form-subfield">
          <span class="form-subfield-label">Решимость</span>
          <input type="number" min="1" v-model="resolveMax">
        </label>
      </div>
    </div>
    <div class="form-actions">
      <button @click="submit">Добавить</button>
      <button @click="emit('cancel')">Отмена</button>
    </div>
  </div>
</template>
