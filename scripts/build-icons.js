// Собирает реестр иконок интерфейса: читает scripts/icons.list, берёт SVG из
// scripts/custom-icons/ (приоритет) или lucide-static и пишет public/js/icons-data.js —
// `window.ICON_DATA = { имя: '<внутренняя разметка svg>' }`. Рантайм (public/js/icons.js)
// от node_modules не зависит; результат коммитится. Запуск: npm run icons.
// Падает, если имя из списка не найдено — иначе в интерфейсе тихо пропала бы иконка.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const listFile = path.join(__dirname, 'icons.list');
const customDir = path.join(__dirname, 'custom-icons');
const lucideDir = path.join(root, 'node_modules', 'lucide-static', 'icons');
const outFile = path.join(root, 'public', 'js', 'icons-data.js');
const licenseDir = path.join(root, 'public', 'assets', 'icons');

const names = fs.readFileSync(listFile, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const dup = names.filter((n, i) => names.indexOf(n) !== i);
if (dup.length) {
  console.error('Дубли в icons.list:', [...new Set(dup)].join(', '));
  process.exit(1);
}

// Внутренняя разметка: всё между <svg ...> и </svg>, без комментариев и лишних пробелов.
function inner(svg) {
  const m = /<svg[^>]*>([\s\S]*?)<\/svg>/.exec(svg);
  if (!m) throw new Error('не svg');
  return m[1].replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').replace(/ \/>/g, '/>').replace(/> </g, '><').trim();
}

const data = {};
const missing = [];
names.forEach((name) => {
  const custom = path.join(customDir, `${name}.svg`);
  const lucide = path.join(lucideDir, `${name}.svg`);
  const file = fs.existsSync(custom) ? custom : (fs.existsSync(lucide) ? lucide : null);
  if (!file) { missing.push(name); return; }
  data[name] = inner(fs.readFileSync(file, 'utf8'));
});

if (missing.length) {
  console.error('Не найдены иконки (нет ни в custom-icons, ни в lucide-static):', missing.join(', '));
  process.exit(1);
}

const body = Object.keys(data).sort().map((n) => `  ${JSON.stringify(n)}: ${JSON.stringify(data[n])}`).join(',\n');
const header = '// СГЕНЕРИРОВАНО scripts/build-icons.js (npm run icons) — руками не править.\n'
  + '// Иконки Lucide (ISC, см. public/assets/icons/LICENSE-lucide.txt) и собственные из scripts/custom-icons.\n';
fs.writeFileSync(outFile, `${header}window.ICON_DATA = {\n${body}\n};\n`);

fs.mkdirSync(licenseDir, { recursive: true });
const lic = path.join(root, 'node_modules', 'lucide-static', 'LICENSE');
if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(licenseDir, 'LICENSE-lucide.txt'));

console.log(`иконок: ${names.length} → ${path.relative(root, outFile)}`);
