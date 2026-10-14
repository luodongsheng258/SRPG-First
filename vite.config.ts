import { defineConfig } from 'vitest/config';

export default defineConfig({
  /* 相对路径：将来用 Tauri / Electron / Capacitor 打包时，
     资源是从 file:// 或自定义协议加载的，绝对路径会 404。 */
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  test: {
    /* core 层是纯 TS、零 DOM 依赖，所以用 node 环境跑，比 jsdom 快很多。
       这本身就是"逻辑与渲染分离"带来的红利。 */
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
