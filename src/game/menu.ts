import { isCleared, isUnlocked, type Campaign, type Progress } from '../core';
import type { LoadedLevel } from './levels';

/**
 * 关卡选择界面。
 *
 * 用 DOM 而不是 Phaser 场景：这里全是列表、按钮和文字 —— 正是 HTML 的主场。
 * 在 canvas 里摆这些既费劲又难改，而且和侧边栏 HUD 的路线不一致。
 */

export interface MenuInput {
  campaign: Campaign;
  levels: LoadedLevel[];
  progress: Progress;
  /** 有未打完的一局时给出关卡 id 和当前回合数 */
  resume: { levelId: string; turns: number; levelName: string } | null;
  /** 存储是否真的落盘 */
  persistent: boolean;
}

export interface Menu {
  render(input: MenuInput): void;
}

export interface MenuHandlers {
  onStart(levelId: string): void;
  onResume(levelId: string): void;
  onReset(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pick(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少界面元素 #${id}，检查 index.html`);
  return node;
}

export function createMenu(handlers: MenuHandlers): Menu {
  const titleEl = pick('menu-title');
  const subtitleEl = pick('menu-subtitle');
  const listEl = pick('level-list');
  const noteEl = pick('menu-save-note');
  const resetEl = pick('menu-reset');

  resetEl.addEventListener('click', () => {
    /* 清进度是不可逆的，问一句。 */
    if (window.confirm('确定清除全部通关进度和未完成的对局？')) handlers.onReset();
  });

  function buildRow(level: LoadedLevel, input: MenuInput): HTMLButtonElement {
    const id = level.entry.id;
    const unlocked = isUnlocked(input.progress, input.campaign, id);
    const cleared = isCleared(input.progress, id);
    const best = input.progress.best[id];

    const row = el('button', 'level');
    row.type = 'button';
    row.disabled = !unlocked;
    if (cleared) row.classList.add('cleared');
    if (!unlocked) row.classList.add('locked');

    row.appendChild(el('span', 'no', String(level.number).padStart(2, '0')));

    const body = el('span', 'body');
    body.appendChild(el('span', 'name', level.entry.name));
    body.appendChild(
      el('span', 'brief', unlocked ? level.entry.brief : '通关上一关后解锁'),
    );
    row.appendChild(body);

    const status = el('span', 'status');
    if (!unlocked) {
      status.textContent = '未解锁';
    } else if (cleared && best !== undefined) {
      status.textContent = `${best.turns} 回合 · 剩 ${best.survivors} 人`;
    } else {
      status.textContent = '未通关';
    }
    row.appendChild(status);

    if (unlocked) row.addEventListener('click', () => handlers.onStart(id));
    return row;
  }

  function buildResumeRow(input: MenuInput): HTMLButtonElement {
    const resume = input.resume;
    if (resume === null) throw new Error('没有未完成的对局');

    const row = el('button', 'level resume');
    row.type = 'button';
    row.appendChild(el('span', 'no', '▶'));

    const body = el('span', 'body');
    body.appendChild(el('span', 'name', `继续：${resume.levelName}`));
    body.appendChild(el('span', 'brief', `未完成的对局，进行到第 ${resume.turns} 回合`));
    row.appendChild(body);
    row.appendChild(el('span', 'status', '继续'));

    row.addEventListener('click', () => handlers.onResume(resume.levelId));
    return row;
  }

  return {
    render(input: MenuInput): void {
      titleEl.textContent = input.campaign.name;
      subtitleEl.textContent = `共 ${input.levels.length} 关`;

      /* replaceChildren 比 innerHTML = '' 干净：不留事件监听残骸，
         也不需要担心拼接字符串带来的转义问题。 */
      listEl.replaceChildren();
      if (input.resume !== null) listEl.appendChild(buildResumeRow(input));
      for (const level of input.levels) listEl.appendChild(buildRow(level, input));

      noteEl.textContent = input.persistent
        ? '进度保存在本机浏览器里'
        : '当前环境无法保存进度 —— 关掉页面就没了';
      noteEl.className = input.persistent ? 'muted' : 'warn';
    },
  };
}
