// Сетка каждой локации — просто прямоугольник gridWidth×gridHeight без
// именованных комнат/зон; ГМ сам расставляет картинки/туман/токены.
// Все функции принимают location ({gridWidth, gridHeight}) первым
// параметром — так модуль остаётся без внутреннего состояния и работает
// с любой локацией, а не только с «активной» глобальной картой.
function isWalkable(location, x, y) {
  return x >= 0 && y >= 0 && x < location.gridWidth && y < location.gridHeight;
}

const DIRECTIONS = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
];

// BFS: все клетки, достижимые из start, потратив не больше energy шагов.
// Возвращает Map "x,y" -> потраченная энергия.
function findReachable(location, start, energy) {
  const visited = new Map();
  visited.set(`${start.x},${start.y}`, 0);
  const queue = [{ x: start.x, y: start.y, cost: 0 }];

  while (queue.length) {
    const current = queue.shift();
    if (current.cost >= energy) continue;
    for (const { dx, dy } of DIRECTIONS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      const nextCost = current.cost + 1;
      if (!isWalkable(location, nx, ny)) continue;
      const key = `${nx},${ny}`;
      if (visited.has(key) && visited.get(key) <= nextCost) continue;
      visited.set(key, nextCost);
      queue.push({ x: nx, y: ny, cost: nextCost });
    }
  }
  return visited;
}

function isReachable(location, start, target, energy) {
  if (!isWalkable(location, target.x, target.y)) return { ok: false, reason: 'not-walkable' };
  const reachable = findReachable(location, start, energy);
  const key = `${target.x},${target.y}`;
  if (!reachable.has(key)) return { ok: false, reason: 'out-of-range' };
  return { ok: true, cost: reachable.get(key) };
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
