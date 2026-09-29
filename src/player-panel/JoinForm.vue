<script setup>
import { ref, computed, onMounted } from 'vue';

const props = defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: true },
});

const name = ref('');
const characterId = ref('');
const code = ref('');
const error = ref('');

const presets = ref([]);
const selectedAvatar = ref(null); // { type: 'preset', url } | { type: 'upload', dataUrl }

const avatarPreviewUrl = computed(() => {
  if (!selectedAvatar.value) return '';
  return selectedAvatar.value.type === 'preset' ? selectedAvatar.value.url : selectedAvatar.value.dataUrl;
});

onMounted(() => {
  fetch('/avatars/presets/manifest.json')
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])
    .then((list) => { presets.value = Array.isArray(list) ? list : []; });

  // Предзаполнение из сохранённой сессии (см. player.js) — код НЕ
  // показываем в поле: он нужен только для тихого авто-рджойна при
  // коннекте, обычный пользователь его тут не вводил.
  const saved = props.bridge.loadSession?.();
  if (saved) {
    name.value = saved.name || '';
    characterId.value = saved.characterId || '';
  }
});

function selectPreset(p) {
  selectedAvatar.value = { type: 'preset', url: p.url };
}

function onFileChange(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  props.bridge.resizeImage(file, 128, (dataUrl) => {
    selectedAvatar.value = { type: 'upload', dataUrl };
  });
}

function characterLabel(c) {
  return c.claimedBy ? `${c.name} (занят: ${c.claimedBy})` : c.name;
}

function join() {
  const nm = name.value.trim() || 'Игрок';
  const cid = characterId.value;
  const cd = code.value.trim();
  if (!cid) return;
  error.value = '';

  // Занятого персонажа не даём выбрать в списке (option disabled), но
  // characterId мог остаться в модели от предзаполнения сессии (см.
  // onMounted) — на случай, если за это время его заняли, подстрахуемся
  // и тут.
  const selected = store.characters.find((c) => c.id === cid);
  if (selected && selected.claimedBy) {
    error.value = `Персонаж уже занят: ${selected.claimedBy}`;
    return;
  }

  props.bridge.socket.emit('join', { role: 'player', name: nm, characterId: cid, code: cd }, (result) => {
    if (!result || !result.ok) {
      error.value = (result && result.reason) || 'Не удалось войти';
      return;
    }

    // Сохраняем сессию — следующая перезагрузка страницы уже пройдёт
    // авто-рджойном в player.js, без этой формы.
    props.bridge.saveSession?.({ characterId: cid, name: nm, code: cd });

    if (selectedAvatar.value && selectedAvatar.value.type === 'preset') {
      props.bridge.socket.emit('avatar:set', { characterId: cid, presetUrl: selectedAvatar.value.url });
    } else if (selectedAvatar.value && selectedAvatar.value.type === 'upload') {
      props.bridge.socket.emit('avatar:upload', { characterId: cid, dataUrl: selectedAvatar.value.dataUrl });
    }

    props.bridge.onJoined({ characterId: cid, name: nm });
  });
}
</script>

<template>
  <h1>Сквозь снег — вход</h1>
  <label class="form-field">
    <span class="form-field-label">Имя</span>
    <input v-model="name" placeholder="Отображаемое имя">
  </label>
  <div class="form-row">
    <label class="form-field">
      <span class="form-field-label">Роль</span>
      <select v-model="characterId">
        <option value="" disabled>Выберите персонажа</option>
        <option v-for="c in store.characters" :key="c.id" :value="c.id" :disabled="!!c.claimedBy">{{ characterLabel(c) }}</option>
      </select>
    </label>
    <label class="form-field form-field-narrow">
      <span class="form-field-label">Код</span>
      <input v-model="code" placeholder="000000" maxlength="6" autocomplete="off">
    </label>
  </div>
  <div class="join-error" :class="{ hidden: !error }">{{ error }}</div>

  <div class="avatar-picker">
    <div class="avatar-picker-head">
      <span>Аватар</span>
      <img class="avatar-preview" :class="{ visible: avatarPreviewUrl }" :src="avatarPreviewUrl" alt="">
    </div>
    <div class="preset-grid">
      <img
        v-for="p in presets"
        :key="p.url"
        :src="p.url"
        :alt="p.label"
        :title="p.label"
        class="preset-option"
        :class="{ selected: selectedAvatar && selectedAvatar.type === 'preset' && selectedAvatar.url === p.url }"
        @click="selectPreset(p)"
      >
    </div>
    <label class="upload-label">
      Загрузить свой аватар
      <input type="file" accept="image/*" hidden @change="onFileChange">
    </label>
    <p class="avatar-upload-hint muted small">
      Форматы: JPG, PNG, GIF, WebP. Картинка автоматически уменьшается до 128×128 —
      лучше всего смотрится квадратное фото (аватар отображается кругом).
    </p>
  </div>

  <div class="row">
    <button class="wide" @click="join">Войти</button>
  </div>
</template>
