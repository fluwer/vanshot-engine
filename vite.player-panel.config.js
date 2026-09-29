const { defineConfig } = require('vite');
const vue = require('@vitejs/plugin-vue');

// Экран игрока (player.html) — отдельный IIFE-бандл, независимый от
// gm-panel.js (см. vite.config.js): Rollup/iife не поддерживает несколько
// entry-points с общими зависимостями (оба импортируют vue) в одной сборке,
// поэтому два независимых конфига вместо одного с несколькими input.
module.exports = defineConfig({
  plugins: [vue()],
  publicDir: false,
  build: {
    outDir: 'public/dist',
    // false — иначе этот прогон стёр бы уже собранный gm-panel.js (см. package.json build).
    emptyOutDir: false,
    assetsDir: '',
    rollupOptions: {
      input: 'src/player-panel/main.js',
      output: {
        format: 'iife',
        entryFileNames: 'player-panel.js',
        assetFileNames: 'player-panel.[ext]',
      },
    },
  },
});
