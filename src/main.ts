import Phaser from 'phaser';

import { exportRoster, recordClear, type BattleState } from './core';
import { BattleScene, type BattleResult } from './game/BattleScene';
import { createHud } from './game/hud';
import { LEVELS, type LoadedLevel } from './game/levels';
import { createMenu } from './game/menu';
import { createSaveStore } from './game/storage';
import { COLORS, TILE } from './game/theme';

/**
 * 应用外壳 —— 只干三件事：
 *   1. 在「关卡选择」和「战斗」两个界面之间切换
 *   2. 把战场状态写进存档 / 从存档恢复
 *   3. 把战斗结束的结果记进进度
 *
 * 游戏规则一行都不在这儿；那是 core 的活。
 * 演出编排一行也不在；那是 BattleScene 的活。
 */

const store = createSaveStore();
const hud = createHud();

const menuEl = pick('menu');
const battleEl = pick('battle');
const resultEl = pick('result');
const resultTitleEl = pick('result-title');
const resultDetailEl = pick('result-detail');

let game: Phaser.Game | null = null;
let current: LoadedLevel | null = null;

/**
 * 每开一局 +1。
 *
 * 结算面板是延时弹出来的（等演出横幅演完），而玩家完全可能在这 1.6 秒里
 * 按 R 重开或者点了返回。没有这个代号的话，旧对局的结算面板会盖在新对局上。
 */
let battleToken = 0;

const menu = createMenu({
  onStart: (levelId) => startLevel(levelId),
  onResume: (levelId) => {
    const saved = store.read().inProgress;
    if (saved !== null && saved.levelId === levelId) startLevel(levelId, saved.state);
    else startLevel(levelId);
  },
  onReset: () => {
    store.reset();
    showMenu();
  },
});

function pick(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少界面元素 #${id}，检查 index.html`);
  return node;
}

/* ---------------------------------------------------------------- 关卡选择 */

function showMenu(): void {
  destroyGame();
  current = null;
  resultEl.hidden = true;
  battleEl.hidden = true;
  menuEl.hidden = false;

  const file = store.read();
  const resume = file.inProgress;
  const canResume = resume !== null && LEVELS.has(resume.levelId);

  menu.render({
    campaign: LEVELS.campaign,
    levels: LEVELS.list(),
    progress: file.progress,
    resume: canResume
      ? {
          levelId: resume.levelId,
          turns: resume.state.turn,
          levelName: LEVELS.require(resume.levelId).entry.name,
        }
      : null,
    persistent: store.persistent,
  });
}

/* -------------------------------------------------------------------- 战斗 */

function destroyGame(): void {
  if (game === null) return;
  game.destroy(true);
  game = null;
}

function startLevel(levelId: string, resume?: BattleState): void {
  const level = LEVELS.require(levelId);
  current = level;
  battleToken += 1;

  /* 每次进关卡都换一个随机种子。用地图里写死的那个的话，
     同一关每次打都是同一套乱数，重打就没意思了。
     （`LEVELS.create` 不传种子时仍然是确定的，方便测试和模拟器复现。） */
  const initial =
    resume ??
    LEVELS.create(
      levelId,
      Math.floor(Math.random() * 0x7fffffff),
      store.read().progress.roster,
    );

  resultEl.hidden = true;
  resultEl.className = '';
  menuEl.hidden = true;
  battleEl.hidden = false;

  hud.reset();
  persist(initial);

  game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'stage',
    width: initial.map.width * TILE,
    height: initial.map.height * TILE,
    backgroundColor: COLORS.bg,
    scene: [
      new BattleScene({
        initial,
        onHud: (model) => hud.update(model),
        onBanner: (title, subtitle, tone) => hud.flashBanner(title, subtitle, tone),
        onStateChange: (state) => persist(state),
        onOutcome: (result) => finish(result),
      }),
    ],
    scale: { mode: Phaser.Scale.NONE },
    render: { antialias: true, roundPixels: true },
  });
}

/** 把当前战场写进存档的「未完成对局」槽位。每次动作后都会调一次。 */
function persist(state: BattleState): void {
  const level = current;
  if (level === null) return;
  store.update((file) => ({
    ...file,
    /* 顺手把队伍成长也存下来。
       注意**输了也保留**：这局挣到的经验不会因为一次失败就蒸发 ——
       那会让"打不过就退出重来"变成严格更优的策略。 */
    progress: { ...file.progress, roster: exportRoster(state, file.progress.roster) },
    inProgress: { levelId: level.entry.id, state },
  }));
}

function finish(result: BattleResult): void {
  const level = current;
  if (level === null) return;

  /* 胜负一定就清掉中途存档：再来一次要从头打，而不是从尸体堆里继续 */
  store.update((file) => ({
    ...file,
    progress:
      result.phase === 'won'
        ? recordClear(file.progress, level.entry.id, {
            turns: result.turns,
            survivors: result.survivors,
          })
        : file.progress,
    inProgress: null,
  }));

  const token = battleToken;
  /* 等胜负横幅演完再弹面板，否则两层遮罩会糊在一起 */
  window.setTimeout(() => {
    if (token !== battleToken) return;
    showResult(result);
  }, 1500);
}

function showResult(result: BattleResult): void {
  resultEl.className = result.phase;
  resultTitleEl.textContent = result.phase === 'won' ? '关卡完成' : '战斗失败';
  resultDetailEl.textContent =
    result.phase === 'won'
      ? `${result.turns} 回合 · 我方残存 ${result.survivors} 人`
      : '我方全灭。可以重打本关，或先回关卡列表。';
  resultEl.hidden = false;
}

/* -------------------------------------------------------------------- 接线 */

pick('result-menu').addEventListener('click', () => showMenu());
pick('result-retry').addEventListener('click', () => {
  if (current !== null) startLevel(current.entry.id);
});
pick('hud-menu').addEventListener('click', () => showMenu());

showMenu();
