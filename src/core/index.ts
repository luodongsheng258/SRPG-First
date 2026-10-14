/**
 * core 层的公开 API。
 *
 * 渲染层（src/game）**只允许**从这个入口导入，不许深入 core 的内部文件。
 * 这条约定会让"逻辑/渲染"的边界在多人协作和 AI 改代码时都保持清晰。
 */

export * from './types';
export * from './util';
export * from './validate';
export * from './campaign';
export * from './terrain';
export * from './weapons';
export * from './progression';
export * from './grid';
export * from './pathfind';
export * from './rng';
export * from './combat';
export * from './turn';
export * from './reinforce';
export * from './state';
export * from './reducer';
export * from './ai';
export * from './loader';
export * from './harness';
