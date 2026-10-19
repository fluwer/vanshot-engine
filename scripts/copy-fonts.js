// Копирует шрифт IBM Plex Sans (вариативный, ось веса 100–700 и ширины 75–100%) из
// node_modules в public/assets/fonts/ — игра раздаёт его сама, интернет не нужен.
// Только подмножества latin + cyrillic (русский UI). Запуск: npm run fonts.
// Результат закоммичен в репозиторий, node_modules для игры не требуется.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = path.join(root, 'node_modules', '@fontsource-variable', 'ibm-plex-sans');
const out = path.join(root, 'public', 'assets', 'fonts');

if (!fs.existsSync(pkg)) {
  console.error('Нет node_modules/@fontsource-variable/ibm-plex-sans — выполните npm install');
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });

const files = [];
['cyrillic', 'latin'].forEach((subset) => {
  ['normal', 'italic'].forEach((style) => {
    files.push(`ibm-plex-sans-${subset}-wdth-${style}.woff2`);
  });
});

files.forEach((name) => {
  const src = path.join(pkg, 'files', name);
  if (!fs.existsSync(src)) throw new Error(`Нет файла шрифта: ${name}`);
  fs.copyFileSync(src, path.join(out, name));
  console.log('шрифт', name, `${(fs.statSync(src).size / 1024).toFixed(1)} КБ`);
});
fs.copyFileSync(path.join(pkg, 'LICENSE'), path.join(out, 'LICENSE-OFL.txt'));
console.log('лицензия OFL скопирована');
