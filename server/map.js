const config = require('./config');

// Сетка локации бесконечная: ходить можно в любую целую клетку в пределах
// ±MAX_COORD (защита от мусора с клиента и потери точности canvas). Размер
// локации (gridWidth×gridHeight) — лишь «домашняя область»: центр для спавна,
// стартовая камера, границы для «Скрыть всё» у тумана; ходьбу он не ограничивает.
// Все функции принимают location первым параметром — модуль остаётся без
// внутреннего состояния и работает с любой локацией, а не только с «активной».
function isWalkable(location, x, y) {
  return Number.isInteger(x) && Number.isInteger(y)
    && Math.abs(x) <= config.MAX_COORD && Math.abs(y) <= config.MAX_COORD;
}

// Препятствий на карте нет, поэтому кратчайший путь между клетками — это
// манхэттенское расстояние (шаг по 4 направлениям, стоимость 1 за клетку).
function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

// Все клетки, достижимые из start, потратив не больше energy шагов (ромб).
// Возвращает Map "x,y" -> потраченная энергия.
function findReachable(location, start, energy) {
  const visited = new Map();
  const radius = Math.max(0, Math.floor(energy) || 0);
  for (let dx = -radius; dx <= radius; dx++) {
    const rest = radius - Math.abs(dx);
    for (let dy = -rest; dy <= rest; dy++) {
      const x = start.x + dx;
      const y = start.y + dy;
      if (!isWalkable(location, x, y)) continue;
      visited.set(`${x},${y}`, Math.abs(dx) + Math.abs(dy));
    }
  }
  return visited;
}

function isReachable(location, start, target, energy) {
  if (!isWalkable(location, target.x, target.y)) return { ok: false, reason: 'not-walkable' };
  const cost = manhattan(start, target);
  if (cost > energy) return { ok: false, reason: 'out-of-range' };
  return { ok: true, cost };
}

function defaultSpawn(location, offsetIndex = 0) {
  const baseX = Math.floor(location.gridWidth / 2);
  const baseY = Math.floor(location.gridHeight / 2);
  // Небольшое смещение, чтобы несколько персонажей не стояли в одной клетке.
  const spread = [
    { dx: 0, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
  ][offsetIndex % 4];
  let x = baseX + spread.dx;
  let y = baseY + spread.dy;
  if (!isWalkable(location, x, y)) { x = baseX; y = baseY; }
  return { x, y };
}

module.exports = { isWalkable, findReachable, isReachable, defaultSpawn };
