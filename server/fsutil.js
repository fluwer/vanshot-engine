const fs = require('fs');

// Атомарная запись ценных данных: во временный файл, прежняя исправная версия — в .bak, затем переименование.
function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  if (fs.existsSync(file)) {
    try {
      JSON.parse(fs.readFileSync(file, 'utf-8'));
      fs.copyFileSync(file, `${file}.bak`);
    } catch (err) { /* текущий файл битый — .bak не затираем */ }
  }
  fs.renameSync(tmp, file);
}

module.exports = { writeFileAtomic };
