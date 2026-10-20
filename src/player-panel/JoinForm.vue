<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import Icon from '../gm-panel/Icon.vue';
import { useGame } from '../gm-panel/useGame';

const props = defineProps({
  store: { type: Object, required: true },
  bridge: { type: Object, required: true },
});

// Заголовок формы входа — из настроек игры (подзаголовок, иначе название).
const { config: gameConfig } = useGame();
const loginTitle = computed(() => `${gameConfig.value.subtitle || gameConfig.value.title || ''} — вход`);

const name = ref('');
const characterId = ref('');
const code = ref('');
const error = ref('');

// Картинку героя задаёт ГМ (окно героя) — при выборе героя в списке сразу показываем её.
// Игрок может лишь загрузить СВОЮ (dataUrl, квадрат 128×128 PNG): она станет картинкой этого героя после входа.
const uploadedAvatar = ref(null);
const selectedHero = computed(() => props.store.characters.find((c) => c.id === characterId.value) || null);
const avatarPreviewUrl = computed(() => uploadedAvatar.value || (selectedHero.value && selectedHero.value.avatar) || '');
// Другой герой — загруженный файл сбрасываем, чтобы он не уехал чужому герою.
watch(characterId, () => { uploadedAvatar.value = null; });

onMounted(() => {
  // Предзаполнение из сохранённой сессии (см. player.js) — код НЕ
  // показываем в поле: он нужен только для тихого авто-рджойна при
  // коннекте, обычный пользователь его тут не вводил.
  const saved = props.bridge.loadSession?.();
  if (saved) {
    name.value = saved.name || '';
    characterId.value = saved.characterId || '';
  }
});

function onFileChange(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  props.bridge.resizeImage(file, 128, (dataUrl) => {
    uploadedAvatar.value = dataUrl;
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
  const selected = props.store.characters.find((c) => c.id === cid);
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

    // Свою картинку отправляем после входа (сервер принимает её только от игрока своему герою).
    if (uploadedAvatar.value) {
      props.bridge.socket.emit('avatar:upload', { characterId: cid, dataUrl: uploadedAvatar.value });
    }

    props.bridge.onJoined({ characterId: cid, name: nm });
  });
}
</script>

<template>
  <h1>{{ loginTitle }}</h1>
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
    <div class="avatar-picker-row">
      <img v-if="avatarPreviewUrl" class="avatar-preview" :src="avatarPreviewUrl" alt="">
      <span
        v-else-if="selectedHero"
        class="avatar-preview avatar-preview-fallback"
        :style="{ background: selectedHero.color || '#888888' }"
      >{{ selectedHero.name[0] }}</span>
      <span v-else class="avatar-preview avatar-preview-empty"></span>
      <div class="avatar-picker-side">
        <span class="avatar-picker-title">{{ uploadedAvatar ? 'Ваша картинка — применится при входе' : (selectedHero ? 'Картинка героя' : 'Выберите героя — здесь появится его картинка') }}</span>
        <label class="upload-label upload-inline">
          <Icon name="upload" /> Загрузить свой аватар
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden @change="onFileChange">
        </label>
        <button v-if="uploadedAvatar" type="button" class="small" @click="uploadedAvatar = null"><Icon name="x" /> Вернуть картинку героя</button>
      </div>
    </div>
    <p class="avatar-upload-hint muted small">
      Свою картинку можно загрузить в формате JPG, PNG, GIF или WebP: она обрежется до квадрата 128×128
      (по центру, чуть выше — для лиц), станет картинкой вашего героя и отображается кругом.
    </p>
  </div>

  <div class="row">
    <button class="wide primary" @click="join">Войти</button>
  </div>
</template>
