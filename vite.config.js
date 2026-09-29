const { defineConfig } = require('vite');
const vue = require('@vitejs/plugin-vue');

// GM-экран (gm.html). Собирается в public/dist как обычный IIFE-скрипт —
// public/gm.html подключает его тегом <script> рядом с остальными
// не-модульными скриптами, без превращения всего проекта в ES-модули.
module.exports = defineConfig({
  plugins: [vue()],
  // Отключаем копирование public/ в outDir — outDir и так лежит внутри
  // public/, а фича publicDir тут не нужна: сервер раздаёт public/ напрямую.
  publicDir: false,
  build: {
    outDir: 'public/dist',
    // false — иначе сборка player-panel.js (см. vite.player-panel.config.js)
    // стёрла бы результат этой сборки при запуске после неё (и наоборот).
    emptyOutDir: false,
    assetsDir: '',
    rollupOptions: {
      input: 'src/gm-panel/main.js',
      output: {
        format: 'iife',
        entryFileNames: 'gm-panel.js',
        assetFileNames: 'gm-panel.[ext]',
      },
    },
  },
});
