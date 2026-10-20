<script setup>
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import IconPicker from './IconPicker.vue';
import { vAutosize } from './autosize.js';
import { request, reasonText, toast } from './gameSettings';

// Каталог навыков игры (server/data/skills.json): название, иконка и описание. Навык выдаётся героям
// в окне героя (CharacterInfoDialog), описание показывается подсказкой. Переименование и удаление
// сервер проводит по всем героям (skill:save / skill:remove в server/index.js).
const props = defineProps({
  bridge: { type: Object, required: true },
  skills: { type: Object, default: () => ({}) },
});

const SKILLS_MAX = 60;
const names = computed(() => Object.keys(props.skills || {}));

// null — форма закрыта; oldName === null — новый навык
const editing = ref(null);
const busy = ref(false);

function add() {
  editing.value = { oldName: null, name: '', icon: 'star', description: '' };
}
function edit(name) {
  const info = props.skills[name] || {};
  editing.value = { oldName: name, name, icon: info.icon || 'star', description: info.description || '' };
}
function cancel() {
  editing.value = null;
}

async function save() {
  const e = editing.value;
  if (!e || busy.value) return;
  const name = e.name.trim();
  if (!name) return;
  busy.value = true;
  const result = await request(props.bridge.socket, 'skill:save', {
    name,
    icon: e.icon,
    description: e.description.trim(),
    oldName: e.oldName,
  });
  busy.value = false;
  if (!result.ok) {
    toast(reasonText(result.reason), 'error');
    return;
  }
  toast(e.oldName ? 'Навык сохранён' : 'Навык добавлен', 'info');
  editing.value = null;
}

async function remove(name) {
  if (!confirm(`Удалить навык «${name}»? Он пропадёт у всех героев.`)) return;
  const result = await request(props.bridge.socket, 'skill:remove', { name });
  if (!result.ok) toast(reasonText(result.reason), 'error');
  else if (editing.value && editing.value.oldName === name) editing.value = null;
}
</script>

<template>
  <div class="game-skills">
    <div class="game-skills-head">
      <h4 class="game-heading">Навыки <span class="muted small">{{ names.length }} из {{ SKILLS_MAX }}</span></h4>
      <button type="button" class="small" :disabled="names.length >= SKILLS_MAX || !!editing" @click="add"><Icon name="plus" /> Добавить</button>
    </div>

    <div v-for="name in names" :key="name" class="game-row game-skill-row">
      <Icon :name="skills[name].icon" class="game-skill-ico" />
      <span class="game-row-label" :data-tip="skills[name].description || null">{{ name }}</span>
      <button type="button" class="small" :disabled="!!editing" data-tip="Изменить" :aria-label="`Изменить навык ${name}`" @click="edit(name)"><Icon name="pen-line" /></button>
      <button type="button" class="small" data-tip="Удалить" :aria-label="`Удалить навык ${name}`" @click="remove(name)"><Icon name="trash-2" /></button>
    </div>
    <p v-if="!names.length" class="muted small">Навыков пока нет. Добавьте первый — потом его можно выдавать героям в их окне.</p>

    <div v-if="editing" class="game-skill-form">
      <div class="game-row">
        <IconPicker v-model="editing.icon" label="Иконка навыка" />
        <input v-model="editing.name" class="game-text" maxlength="40" placeholder="Название навыка" aria-label="Название навыка" @keydown.enter.prevent="save">
      </div>
      <textarea v-model="editing.description" rows="3" maxlength="400" placeholder="Что умеет персонаж с этим навыком — показывается подсказкой" aria-label="Описание навыка" v-autosize></textarea>
      <div class="form-actions">
        <button class="primary" :disabled="busy || !editing.name.trim()" @click="save"><Icon name="save" /> {{ editing.oldName ? 'Сохранить' : 'Добавить' }}</button>
        <button :disabled="busy" @click="cancel">Отмена</button>
      </div>
    </div>
  </div>
</template>
