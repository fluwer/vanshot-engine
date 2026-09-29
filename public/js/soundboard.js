// Саундборд: список звуков подтягивается из assets/sounds/manifest.json — чтобы
// добавить новый звук, достаточно положить файл в assets/sounds/ и дописать
// манифест (id/label/file), без правок кода. Сервер — тупой ретранслятор
// события 'sound:play' всем участникам (см. engine/server/index.js).

const soundAudioCache = new Map();
// На клиенте одновременно звучит только один звук — новый обрывает предыдущий.
let currentlyPlaying = null;

function getSoundAudio(file) {
  let audio = soundAudioCache.get(file);
  if (!audio) {
    audio = new Audio(`assets/sounds/${file}`);
    soundAudioCache.set(file, audio);
  }
  return audio;
}

function playSound(file) {
  const audio = getSoundAudio(file);
  if (currentlyPlaying && currentlyPlaying !== audio) {
    currentlyPlaying.pause();
    currentlyPlaying.currentTime = 0;
  }
  currentlyPlaying = audio;
  audio.currentTime = 0;
  audio.play().catch(() => {}); // автоплей может быть заблокирован до жеста пользователя
}

// containerId — элемент, в который рендерятся кнопки (панель у ГМ/игрока).
// opts.canManage — изначальное состояние; кнопки удаления рядом с каждым
// звуком показываются, только только пока включён режим редактирования
// (см. SoundPanel.vue) — так во время игры случайный клик по саундборду не
// удаляет звук вместо того, чтобы его проиграть. Переключается через
// возвращаемый объект { setManage(bool) }, а не заново переданный opts —
// список уже отрисован и живёт в closure.
function initSoundboard(socket, containerId, opts = {}) {
  const container = document.getElementById(containerId);
  if (!container) return null;
  let canManage = !!opts.canManage;

  let sounds = [];

  function render() {
    container.innerHTML = '';
    if (!sounds.length) {
      container.innerHTML = '<span class="muted small">Нет звуков — добавьте файлы в assets/sounds/ и manifest.json</span>';
      return;
    }
    sounds.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'soundboard-row';
      const btn = document.createElement('button');
      btn.className = 'small soundboard-btn';
      btn.textContent = s.label || s.id;
      btn.addEventListener('click', () => socket.emit('sound:play', { soundId: s.id, label: s.label || s.id }));
      row.appendChild(btn);
      if (canManage) {
        const delBtn = document.createElement('button');
        delBtn.className = 'small danger';
        delBtn.textContent = '✕';
        delBtn.title = 'Удалить звук';
        delBtn.addEventListener('click', () => {
          if (confirm(`Удалить звук «${s.label || s.id}»?`)) socket.emit('sound:remove', { id: s.id });
        });
        row.appendChild(delBtn);
      }
      container.appendChild(row);
    });
  }

  // Манифест теперь может меняться в рантайме (загрузка/удаление ГМом) —
  // { cache: 'no-store' }, чтобы браузер не отдавал устаревшую версию.
  function loadManifest() {
    fetch('assets/sounds/manifest.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])
      .then((list) => {
        sounds = Array.isArray(list) ? list : [];
        render();
      });
  }

  loadManifest();
  socket.on('sound:manifest-updated', loadManifest);

  socket.on('sound:play', ({ soundId }) => {
    const sound = sounds.find((s) => s.id === soundId);
    if (sound) playSound(sound.file);
  });

  return {
    setManage(value) {
      canManage = !!value;
      render();
    },
  };
}

window.initSoundboard = initSoundboard;
