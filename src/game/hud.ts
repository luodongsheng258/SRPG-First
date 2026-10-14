import {
  attackPower,
  EXP_PER_LEVEL,
  MAX_LEVEL,
  triangleLabel,
  type BattlePhase,
  type CombatForecast,
  type Team,
  type TerrainDef,
  type Unit,
  type Vec2,
  type WeaponKind,
} from '../core';

/**
 * HUD = 用 DOM 画的侧边栏。
 *
 * 这是 web 技术栈做游戏的一个"作弊"优势：
 *   canvas 负责网格和单位，HTML/CSS 负责信息面板。
 *   写 UI 比在 canvas 里摆文字舒服一个数量级，而且天然支持选中/滚动/无障碍。
 *   你是 uniapp 出身，这部分几乎零学习成本。
 *
 * 渲染层 → HUD 是单向的：Scene 每次状态变化调用 onHud(model)，
 * HUD 只读不改。所以 HUD 里绝不允许出现 game logic。
 */

export interface HudModel {
  turn: number;
  activeTeam: Team;
  phase: BattlePhase;

  playerAlive: number;
  enemyAlive: number;

  selected: Unit | null;
  hoveredUnit: Unit | null;
  hoverTerrain: TerrainDef | null;

  /** 战斗预测（假设全中） */
  forecast: CombatForecast | null;
  /** 预测是"站在这格打"得出来的；与 selected.pos 不同时说明需要先移动 */
  forecastFrom: Vec2 | null;
  forecastTarget: Unit | null;

  log: string[];
  hint: string;
  /** 音效是否静音（按 M 切换） */
  muted: boolean;
  /** 是否显示敌方威胁范围（按 T 切换） */
  showThreat: boolean;
}

export interface Hud {
  update(model: HudModel): void;
  /** 阶段 / 胜负横幅：一闪而过，不参与常规刷新 */
  flashBanner(title: string, subtitle: string, tone?: 'neutral' | 'won' | 'lost'): void;
  /** 换关卡时清掉跨局残留（日志长度缓存、横幅、结算提示） */
  reset(): void;
}

/** HTML 转义。单位名/地名将来可能来自玩家自制关卡，不能直接拼 innerHTML。 */
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function hpColor(ratio: number): string {
  if (ratio > 0.6) return '#46c46a';
  if (ratio > 0.3) return '#d8c14a';
  return '#d8503f';
}

function hpBar(unit: Unit): string {
  const ratio = Math.max(0, Math.min(1, unit.hp / unit.maxHp));
  return `<div class="hpbar"><div class="hpfill" style="width:${(ratio * 100).toFixed(1)}%;background:${hpColor(ratio)}"></div></div>`;
}

/**
 * 经验条。
 *
 * 和血条分开、用完全不同的颜色 —— 两条进度条挨在一起时，
 * 颜色不分家就会看错（"我这人怎么快死了"其实是快升级了）。
 */
function expBar(unit: Unit): string {
  const capped = unit.level >= MAX_LEVEL;
  const ratio = capped ? 1 : Math.max(0, Math.min(1, unit.exp / EXP_PER_LEVEL));
  const label = capped ? 'MAX' : `EXP ${unit.exp}/${EXP_PER_LEVEL}`;
  return (
    `<div class="exprow"><span class="k">${label}</span></div>` +
    `<div class="expbar"><div class="expfill" style="width:${(ratio * 100).toFixed(1)}%"></div></div>`
  );
}

const KIND_LABEL: Record<WeaponKind, string> = {
  sword: '剑',
  axe: '斧',
  lance: '枪',
  bow: '弓',
  tome: '魔法',
};

function unitCard(unit: Unit, label: string): string {
  const status = unit.done ? '已行动' : unit.moved ? '已移动' : '待命';
  const power = attackPower(unit);
  return [
    `<div class="row"><span class="k">${esc(label)}</span>`,
    `<span class="v ${unit.team}">Lv ${unit.level}</span></div>`,
    `<div class="row"><span class="k">HP</span>`,
    `<span class="v ${unit.team}">${unit.hp} / ${unit.maxHp}</span></div>`,
    hpBar(unit),
    expBar(unit),
    `<div class="row"><span class="k">武器</span><span class="v">${esc(unit.weapon.name)}（${KIND_LABEL[unit.weapon.kind]}）</span></div>`,
    `<div class="row"><span class="k">攻 / 防 / 速</span><span class="v">${power} / ${unit.def} / ${unit.spd}</span></div>`,
    `<div class="row"><span class="k">射程 / 暴击</span><span class="v">${unit.weapon.range[0]} ~ ${unit.weapon.range[1]} / ${unit.weapon.crit}%</span></div>`,
    `<div class="row"><span class="k">状态</span><span class="v">${status}</span></div>`,
  ].join('');
}

function forecastCard(model: HudModel): string {
  const { forecast: f, forecastTarget, selected, forecastFrom } = model;
  if (!f || !forecastTarget || !selected) {
    return '<span class="muted">把光标移到攻击范围内的敌人上</span>';
  }

  const needsMove =
    forecastFrom !== null &&
    (forecastFrom.x !== selected.pos.x || forecastFrom.y !== selected.pos.y);
  const rows: string[] = [];

  /* 相克关系放最上面 —— 它是"这一下该不该打"的第一判断依据 */
  if (f.triangle !== 'neutral') {
    const cls = f.triangle === 'advantage' ? 'good' : 'risk';
    rows.push(
      `<div class="row ${cls}"><span class="k">武器相克</span><span class="v ${cls}">${triangleLabel(f.triangle)}</span></div>`,
    );
  }

  if (needsMove && forecastFrom) {
    rows.push(
      `<div class="row"><span class="k">需先移动到</span><span class="v">(${forecastFrom.x}, ${forecastFrom.y})</span></div>`,
    );
  }

  rows.push(
    `<div class="row"><span class="k">${esc(selected.name)} 命中</span><span class="v hit">${f.attacker.hit}%</span></div>`,
    `<div class="row"><span class="k">${esc(selected.name)} 伤害</span><span class="v">${f.attacker.damage}${f.attacker.doubles ? ' ×2' : ''}</span></div>`,
  );
  if (f.attacker.crit > 0) {
    rows.push(
      `<div class="row"><span class="k">会心几率</span><span class="v hit">${f.attacker.crit}%（×3 伤害）</span></div>`,
    );
  }

  if (f.counter) {
    rows.push(
      `<div class="row"><span class="k">${esc(forecastTarget.name)} 反击命中</span><span class="v hit">${f.counter.hit}%</span></div>`,
      `<div class="row"><span class="k">${esc(forecastTarget.name)} 反击伤害</span><span class="v">${f.counter.damage}${f.counter.doubles ? ' ×2' : ''}</span></div>`,
    );
  } else {
    rows.push('<div class="row"><span class="k">对方反击</span><span class="v">无法反击</span></div>');
  }

  rows.push(
    `<div class="row"><span class="k">预计剩余</span><span class="v">${f.attackerHpAfter} / ${f.defenderHpAfter}</span></div>`,
  );

  if (f.defenderWillDie) rows.push('<div class="row kill"><span class="k">结果</span><span class="v kill">可击杀</span></div>');
  if (f.attackerWillDie) rows.push('<div class="row risk"><span class="k">警告</span><span class="v risk">我方会阵亡</span></div>');

  return rows.join('');
}

function terrainCard(terrain: TerrainDef | null): string {
  if (!terrain) return '<span class="muted">—</span>';
  const move = terrain.moveCost === null ? '不可通行' : String(terrain.moveCost);
  return [
    `<div class="row"><span class="k">${esc(terrain.name)}</span><span class="v">—</span></div>`,
    `<div class="row"><span class="k">移动消耗</span><span class="v">${move}</span></div>`,
    `<div class="row"><span class="k">防御 +</span><span class="v">${terrain.defBonus}</span></div>`,
    `<div class="row"><span class="k">闪避 +</span><span class="v">${terrain.avoidBonus}%</span></div>`,
  ].join('');
}

export function createHud(): Hud {
  const pick = (id: string): HTMLElement => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`HUD 缺少元素 #${id}，检查 index.html`);
    return node;
  };

  const turnEl = pick('turn');
  const phaseEl = pick('phase');
  const playerCountEl = pick('player-count');
  const enemyCountEl = pick('enemy-count');
  const unitInfoEl = pick('unit-info');
  const forecastEl = pick('forecast');
  const terrainEl = pick('terrain');
  const logEl = pick('log');
  const bannerEl = pick('banner');
  const fxBannerEl = pick('fx-banner');
  const sfxStateEl = pick('sfx-state');
  const threatStateEl = pick('threat-state');

  let lastLogLength = -1;

  /**
   * 阶段 / 胜负横幅。
   *
   * 注意这必须是「先摘 class → 强制重排 → 再挂 class」三步：
   * 少了强制重排那一步，连续触发同一条横幅时浏览器认为 class 没变，
   * 不会重放动画，第二次就什么都不显示。
   */
  function flashBanner(
    title: string,
    subtitle: string,
    tone: 'neutral' | 'won' | 'lost' = 'neutral',
  ): void {
    fxBannerEl.className = tone === 'neutral' ? '' : tone;
    fxBannerEl.innerHTML = `<div class="t">${esc(title)}</div><div class="s">${esc(subtitle)}</div>`;
    void fxBannerEl.offsetWidth;
    fxBannerEl.classList.add('show');
  }

  return {
    update(model: HudModel): void {
      turnEl.textContent = String(model.turn);

      phaseEl.textContent = model.activeTeam === 'player' ? '我方行动' : '敌方行动';
      phaseEl.className = `v ${model.activeTeam}`;

      playerCountEl.textContent = String(model.playerAlive);
      enemyCountEl.textContent = String(model.enemyAlive);

      /* 选中单位：优先显示选中，其次显示光标下的单位 */
      const shown = model.selected ?? model.hoveredUnit;
      if (shown) {
        const label = model.selected ? '选中' : '光标';
        unitInfoEl.className = '';
        unitInfoEl.innerHTML = unitCard(shown, `${label}：${shown.name}`);
      } else {
        unitInfoEl.className = 'muted';
        unitInfoEl.textContent = model.hint;
      }

      forecastEl.innerHTML = forecastCard(model);
      terrainEl.innerHTML = terrainCard(model.hoverTerrain);

      sfxStateEl.textContent = model.muted ? '音效：关' : '音效：开';
      sfxStateEl.className = model.muted ? 'muted' : '';

      threatStateEl.textContent = model.showThreat ? '威胁范围：开' : '威胁范围：关';
      threatStateEl.className = model.showThreat ? '' : 'muted';

      /* 只在日志变长时重建 DOM 并滚到底，避免每帧重排 */
      if (model.log.length !== lastLogLength) {
        lastLogLength = model.log.length;
        logEl.innerHTML = model.log
          .slice(-40)
          .map((line) => `<div>${esc(line)}</div>`)
          .join('');
        logEl.scrollTop = logEl.scrollHeight;
      }

      if (model.phase === 'won') {
        bannerEl.className = 'won';
        bannerEl.textContent = '★ 我方胜利——按 R 重开';
      } else if (model.phase === 'lost') {
        bannerEl.className = 'lost';
        bannerEl.textContent = '✖ 我方全灭——按 R 重开';
      } else {
        bannerEl.className = '';
        bannerEl.textContent = '';
      }
    },

    flashBanner,

    reset(): void {
      /* 不重置的话，新关卡的日志可能刚好和上一局一样长，就不会重绘 */
      lastLogLength = -1;
      fxBannerEl.className = '';
      fxBannerEl.innerHTML = '';
      bannerEl.className = '';
      bannerEl.textContent = '';
    },
  };
}
