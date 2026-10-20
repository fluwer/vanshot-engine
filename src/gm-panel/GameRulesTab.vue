<script setup>
import { reactive, computed, watch } from 'vue';
import Icon from './Icon.vue';
import { useGame } from './useGame';
import { useDock } from './useDock.js';
import { saveGame, resetGame } from './gameSettings';

// Вкладка «Проверки»: как считается бросок проверки и инициатива. Механика остаётся прежней —
// кубик + атрибут против сложности (DC) — настраиваются кубик, пороги критов, цена и размер бонуса
// за ресурс, атрибут инициативы, пресеты сложности и набор кубиков урона (server/gameConfig.js, check).
const props = defineProps({ bridge: { type: Object, required: true } });

const { config, attr, res, attrIds } = useGame();
const dock = useDock();

const DIE_SIDES = [4, 6, 8, 10, 12, 20]; // у каждого есть форма в public/js/diceFx.js
const DC_MAX_PRESETS = 6;

const draft = reactive({
  die: 20,
  critSuccess: 20, // null — выключено
  critFail: 1,
  cost: 1,
  amount: 2,
  initiativeAttr: 'body',
  dcPresets: [],
  damageDice: [],
});

function load() {
  const c = config.value.check || {};
  draft.die = c.die || 20;
  draft.critSuccess = c.critSuccess ?? null;
  draft.critFail = c.critFail ?? null;
  draft.cost = (c.bonus || {}).cost ?? 1;
  draft.amount = (c.bonus || {}).amount ?? 2;
  draft.initiativeAttr = c.initiativeAttr || 'body';
  draft.dcPresets = (c.dcPresets || []).map((p) => ({ label: p.label, value: p.value }));
  draft.damageDice = [...(c.damageDice || [])];
}
watch(config, load, { immediate: true });
watch(() => dock.current.value !== 'game', (away) => { if (away) load(); });

// Смена кубика: пороги критов должны лежать в его пределах — подстраиваем (крит-успех = старшая грань, провал = 1).
function onDie(value) {
  draft.die = Number(value);
  if (draft.critSuccess !== null && draft.critSuccess > draft.die) draft.critSuccess = draft.die;
  if (draft.critFail !== null && draft.critFail >= draft.die) draft.critFail = 1;
}

const numOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

const critHint = computed(() => {
  const s = draft.critSuccess;
  const f = draft.critFail;
  if (s !== null && s > draft.die) return `Крит-успех не может быть выше d${draft.die}`;
  if (f !== null && f >= draft.die) return `Крит-провал должен быть ниже d${draft.die}`;
  if (s !== null && f !== null && f >= s) return 'Крит-провал должен быть ниже крит-успеха';
  return '';
});

function toggleDamage(n) {
  const i = draft.damageDice.indexOf(n);
  if (i === -1) draft.damageDice.push(n); else draft.damageDice.splice(i, 1);
  draft.damageDice.sort((a, b) => a - b);
}

function addPreset() {
  if (draft.dcPresets.length >= DC_MAX_PRESETS) return;
  draft.dcPresets.push({ label: 'Сложность', value: 12 });
}

// Сохранённые параметры в той же форме, что и buildCheck(): по ним видно, правил ли ГМ что-то.
function savedCheck() {
  const c = config.value.check || {};
  return {
    die: c.die,
    critSuccess: c.critSuccess ?? null,
    critFail: c.critFail ?? null,
    bonus: { cost: (c.bonus || {}).cost, amount: (c.bonus || {}).amount },
    initiativeAttr: c.initiativeAttr,
    dcPresets: (c.dcPresets || []).map((p) => ({ label: p.label, value: p.value })),
    damageDice: [...(c.damageDice || [])].sort((a, b) => a - b),
  };
}
const dirty = computed(() => JSON.stringify(buildCheck()) !== JSON.stringify(savedCheck()));

function buildCheck() {
  return {
    die: draft.die,
    critSuccess: numOrNull(draft.critSuccess),
    critFail: numOrNull(draft.critFail),
    bonus: { cost: Number(draft.cost) || 0, amount: Number(draft.amount) || 0 },
    initiativeAttr: draft.initiativeAttr,
    dcPresets: draft.dcPresets.map((p) => ({ label: String(p.label).trim(), value: Number(p.value) })),
    damageDice: [...draft.damageDice].sort((a, b) => a - b),
  };
}

const canSave = computed(() => dirty.value && !critHint.value && draft.damageDice.length > 0 && draft.dcPresets.length > 0);

async function save() {
  await saveGame(props.bridge.socket, { check: buildCheck() });
}

async function toExample() {
  if (!confirm('Вернуть параметры проверок, как в примере игры (d20, крит 20/1, бонус −1 → +2)?')) return;
  await resetGame(props.bridge.socket, 'check');
}
</script>

<template>
  <div class="game-tab">
    <p class="muted small game-hint">
      Бросок проверки — кубик + атрибут персонажа против сложности (DC), которую ставит ГМ.
      Изменения действуют на новые броски и на инициативу в новом бою.
    </p>

    <h4 class="game-heading">Кубик проверок</h4>
    <div class="game-row">
      <label class="game-row-label" for="game-die">Кубик</label>
      <select id="game-die" class="game-select" :value="draft.die" @change="onDie($event.target.value)">
        <option v-for="n in DIE_SIDES" :key="n" :value="n">d{{ n }}</option>
      </select>
    </div>
    <div class="game-row">
      <label class="game-row-label" for="game-crit-ok" data-tip="Результат кубика от этого значения и выше — критический успех. Пусто — критов успеха нет.">Крит-успех от</label>
      <input id="game-crit-ok" type="number" class="game-num" min="2" :max="draft.die" placeholder="нет" :value="draft.critSuccess ?? ''" @input="draft.critSuccess = numOrNull($event.target.value)">
    </div>
    <div class="game-row">
      <label class="game-row-label" for="game-crit-fail" data-tip="Результат кубика до этого значения включительно — критический провал. Пусто — критов провала нет.">Крит-провал до</label>
      <input id="game-crit-fail" type="number" class="game-num" min="1" :max="draft.die - 1" placeholder="нет" :value="draft.critFail ?? ''" @input="draft.critFail = numOrNull($event.target.value)">
    </div>
    <p v-if="critHint" class="game-warn small">{{ critHint }}</p>

    <h4 class="game-heading">Бонус за «{{ res('resolve').label }}»</h4>
    <div class="game-row">
      <label class="game-row-label" for="game-cost">Цена, очков</label>
      <input id="game-cost" type="number" class="game-num" min="0" max="3" v-model="draft.cost">
    </div>
    <div class="game-row">
      <label class="game-row-label" for="game-amount">Бонус к броску</label>
      <input id="game-amount" type="number" class="game-num" min="0" max="5" v-model="draft.amount">
    </div>

    <h4 class="game-heading">Инициатива</h4>
    <div class="game-row">
      <label class="game-row-label" for="game-init">К кубику добавляется</label>
      <select id="game-init" class="game-select" v-model="draft.initiativeAttr">
        <option v-for="id in attrIds" :key="id" :value="id">{{ attr(id).label }}</option>
      </select>
    </div>

    <h4 class="game-heading">Пресеты сложности (DC)</h4>
    <div v-for="(p, i) in draft.dcPresets" :key="i" class="game-row">
      <input v-model="p.label" class="game-text" maxlength="16" placeholder="Название" :aria-label="`Название пресета ${i + 1}`">
      <input v-model.number="p.value" type="number" class="game-num" min="1" max="40" :aria-label="`DC пресета ${i + 1}`">
      <button
        type="button"
        class="small game-row-end"
        :disabled="draft.dcPresets.length <= 1"
        data-tip="Убрать пресет"
        aria-label="Убрать пресет"
        @click="draft.dcPresets.splice(i, 1)"
      ><Icon name="trash-2" /></button>
    </div>
    <button type="button" class="small" :disabled="draft.dcPresets.length >= DC_MAX_PRESETS" @click="addPreset"><Icon name="plus" /> Добавить пресет</button>

    <h4 class="game-heading">Кубики урона</h4>
    <div class="game-row game-dice-row">
      <label v-for="n in DIE_SIDES" :key="n" class="game-chip" :class="{ on: draft.damageDice.includes(n) }">
        <input type="checkbox" :checked="draft.damageDice.includes(n)" @change="toggleDamage(n)"> d{{ n }}
      </label>
    </div>
    <p v-if="!draft.damageDice.length" class="game-warn small">Нужен хотя бы один кубик урона</p>

    <div class="form-actions">
      <button class="primary" :disabled="!canSave" @click="save"><Icon name="save" /> Сохранить</button>
      <button :disabled="!dirty" @click="load">Отмена</button>
    </div>
    <button type="button" class="small game-reset" @click="toExample">Вернуть как в примере</button>
  </div>
</template>
