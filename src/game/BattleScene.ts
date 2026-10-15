import Phaser from 'phaser';

import {
  applyAction,
  canReach,
  findPath,
  forecast,
  inBounds,
  key,
  livingUnitsOf,
  parseKey,
  planTurn,
  reachableTiles,
  samePos,
  teamLabel,
  terrainAt,
  triangleEdge,
  gainsText,
  unitAt,
  type Action,
  type BattleState,
  type CombatForecast,
  type MoveRange,
  type SkillDef,
  type TerrainDef,
  type Unit,
  type Vec2,
} from '../core';

import { createAudio, type Audio } from './audio';
import {
  buildFeedback,
  isStrikeFx,
  type Feedback,
  type FxEvent,
  type StrikeFx,
} from './feedback';
import { FX, FxLayer, mapCenter } from './fx';
import type { HudModel } from './hud';
import { computeHighlights, computeThreatZone, resolveClick, type UiMode } from './interaction';
import { COLORS, FONT, TILE, tileCenter } from './theme';

/**
 * 渲染层。
 *
 * 铁律：**这个文件里不许出现任何游戏规则。**
 *   - 想算移动范围 → 调 core 的 computeMoveRange
 *   - 想改状态     → 派发 Action 给 core 的 applyAction
 *   - 想判合法性   → 调 core 的 canAct / canReach
 *
 * 场景自己只保存"UI 状态"：当前选中谁、鼠标在哪格、有哪些高亮。
 * 这样将来换引擎（或者加一个手机版输入层），只有这个文件要重写。
 */

/** 战斗结束时的结算信息 */
export interface BattleResult {
  phase: 'won' | 'lost';
  turns: number;
  /** 我方残存人数 */
  survivors: number;
}

export interface BattleSceneDeps {
  initial: BattleState;
  onHud: (model: HudModel) => void;
  /** 阶段 / 胜负横幅。走 DOM，不受镜头缩放影响。 */
  onBanner: (title: string, subtitle: string, tone?: 'neutral' | 'won' | 'lost') => void;
  /** 每次战场状态变化后回调，外层拿它做中途存档 */
  onStateChange: (state: BattleState) => void;
  /** 分出胜负时回调一次，外层拿它记录进度 */
  onOutcome: (result: BattleResult) => void;
}

interface UnitView {
  container: Phaser.GameObjects.Container;
  hpFill: Phaser.GameObjects.Rectangle;
}

/** syncUnits 摘下来、等着播阵亡动画的视图 */
interface RemovedView {
  id: string;
  view: UnitView;
}

export class BattleScene extends Phaser.Scene {
  private readonly initial: BattleState;
  private readonly onHud: (model: HudModel) => void;
  private readonly onBanner: BattleSceneDeps['onBanner'];
  private readonly onStateChange: (state: BattleState) => void;
  private readonly onOutcome: (result: BattleResult) => void;

  private battle!: BattleState;

  private uiMode: UiMode = 'idle';
  private selectedId: string | null = null;
  /**
   * 下一次攻击要用的战技。`null` = 普通攻击。
   *
   * 这是**纯 UI 状态**，不进 BattleState —— 它描述的是"玩家打算怎么做"，
   * 而不是"世界现在是什么样"。真正生效是在派发攻击动作的那一刻。
   */
  private pendingSkillId: string | null = null;
  private hoverTile: Vec2 | null = null;

  private moveRange: MoveRange | null = null;
  /** 可以停留的格子（移动范围） */
  private moveKeys: Set<string> = new Set();
  /** 以当前位置就能打到的格子（点击校验用） */
  private attackNowKeys: Set<string> = new Set();
  /** 移动之后"有可能"打到的格子（仅用于红色提示） */
  private attackPotentialKeys: Set<string> = new Set();
  /** 移动范围里"踏进去就停"的格子（敌方控制区 ZOC） */
  private zocStopKeys: Set<string> = new Set();

  /**
   * 敌方威胁范围（按 T 切换）。
   *
   * 刻意默认关闭：它盖住的面积很大，一直开着整张棋盘会很吵。
   * 只在"我要决定这个人站哪"的那一刻打开才有价值。
   *
   * 缓存起来而不是每次 refresh 重算 —— refresh 在鼠标移动时就会触发，
   * 而重算一遍要对每个敌人跑一次 Dijkstra。
   */
  private showThreat = false;
  private threatKeys: Set<string> = new Set();

  /**
   * 演出锁。
   *
   * 动画播放期间拒绝一切新指令 —— 否则玩家能在敌方突进到一半时点走自己的单位，
   * 或者抢在阵亡动画结束前再攻击一次，状态和画面就会脱节。
   * 这是加入异步演出后**必须**补上的一环。
   */
  private busy = false;

  /**
   * 演出代号。每次重开关卡 +1。
   *
   * 敌方阶段的计划和所有动画回调都会捕获当时的代号，
   * 执行前先比对 —— 玩家中途按 R 重开时，旧的回调会自己作废，
   * 而不是拿着过期的计划去操作一个全新的战场。
   */
  private runId = 0;

  private terrainGfx!: Phaser.GameObjects.Graphics;
  private overlayGfx!: Phaser.GameObjects.Graphics;
  private cursorGfx!: Phaser.GameObjects.Graphics;
  private fx!: FxLayer;
  private audio!: Audio;
  private readonly unitViews = new Map<string, UnitView>();

  constructor(deps: BattleSceneDeps) {
    super('Battle');
    this.initial = deps.initial;
    this.onHud = deps.onHud;
    this.onBanner = deps.onBanner;
    this.onStateChange = deps.onStateChange;
    this.onOutcome = deps.onOutcome;
  }

  /* Phaser 生命周期钩子。不加 override：不同版本 Scene 基类的声明方式略有差异，
     加上反而容易在升级引擎时炸掉。 */
  create(): void {
    this.battle = this.initial;
    this.audio = createAudio();

    this.terrainGfx = this.add.graphics().setDepth(0);
    this.overlayGfx = this.add.graphics().setDepth(10);
    this.cursorGfx = this.add.graphics().setDepth(30);
    this.fx = new FxLayer(this);

    this.drawTerrain();
    this.bindInput();

    this.syncUnits(null);
    this.refresh();
  }

  /* ---------------------------------------------------------------- 绘制 */

  private drawTerrain(): void {
    const g = this.terrainGfx;
    g.clear();
    const { map } = this.battle;

    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const terrain = terrainAt(map, { x, y });
        const px = x * TILE;
        const py = y * TILE;

        g.fillStyle(terrain.color, 1);
        g.fillRect(px, py, TILE, TILE);

        g.lineStyle(1, 0x000000, 0.22);
        g.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);

        /* 有掩护的地形加一圈内框，一眼能看出"这里有防御加成" */
        if (terrain.defBonus > 0) {
          g.lineStyle(2, 0xffffff, 0.16);
          g.strokeRect(px + 9, py + 9, TILE - 18, TILE - 18);
        }
      }
    }
  }

  private paintTile(
    g: Phaser.GameObjects.Graphics,
    tile: Vec2,
    fill: number,
    edge: number,
  ): void {
    const px = tile.x * TILE;
    const py = tile.y * TILE;
    g.fillStyle(fill, 0.3);
    g.fillRect(px + 1, py + 1, TILE - 2, TILE - 2);
    g.lineStyle(2, edge, 0.8);
    g.strokeRect(px + 2, py + 2, TILE - 4, TILE - 4);
  }

  /**
   * 控制区落点：琥珀色实心 + 亮边。
   *
   * 为什么不用 `paintTile`：那些格子**本来就在蓝色移动范围里**，
   * 半透明叠加会混成脏绿色。所以这里用较高不透明度的填充直接盖掉底色 ——
   * 颜色本身就是信息："蓝色能自由走，琥珀色走进去就停"。
   */
  private paintZocTile(g: Phaser.GameObjects.Graphics, p: Vec2): void {
    const px = p.x * TILE;
    const py = p.y * TILE;

    g.fillStyle(COLORS.zocFill, 0.62);
    g.fillRect(px + 1, py + 1, TILE - 2, TILE - 2);
    g.lineStyle(3, COLORS.zocEdge, 0.95);
    g.strokeRect(px + 3, py + 3, TILE - 6, TILE - 6);
  }

  /**
   * 画一片格子：淡填充 + **只描外轮廓**。
   *
   * 不逐格描边是刻意的 —— 那样会和移动范围/攻击范围的方框糊成一片，
   * 分不清哪块是"危险区"。只勾外轮廓才有战棋里那种经典红区的观感，
   * 也才压得住它盖住的大片面积。
   */
  private paintRegion(
    g: Phaser.GameObjects.Graphics,
    keys: ReadonlySet<string>,
    fill: number,
    fillAlpha: number,
    edge: number,
    edgeAlpha: number,
  ): void {
    g.fillStyle(fill, fillAlpha);
    for (const k of keys) {
      const p = parseKey(k);
      g.fillRect(p.x * TILE, p.y * TILE, TILE, TILE);
    }

    g.lineStyle(2, edge, edgeAlpha);
    for (const k of keys) {
      const p = parseKey(k);
      const px = p.x * TILE;
      const py = p.y * TILE;
      /* 只画"邻居不在集合里"的那几条边，合起来就是整片区域的外轮廓 */
      if (!keys.has(key({ x: p.x, y: p.y - 1 }))) g.lineBetween(px, py, px + TILE, py);
      if (!keys.has(key({ x: p.x, y: p.y + 1 }))) g.lineBetween(px, py + TILE, px + TILE, py + TILE);
      if (!keys.has(key({ x: p.x - 1, y: p.y }))) g.lineBetween(px, py, px, py + TILE);
      if (!keys.has(key({ x: p.x + 1, y: p.y }))) g.lineBetween(px + TILE, py, px + TILE, py + TILE);
    }
  }

  private drawOverlay(): void {
    const g = this.overlayGfx;
    g.clear();

    /* 威胁范围垫在最底下，让移动/攻击范围盖在它上面 */
    if (this.showThreat) {
      this.paintRegion(g, this.threatKeys, COLORS.threatFill, 0.18, COLORS.threatEdge, 0.6);
    }

    /* 移动范围只在"还没移动"时显示 */
    if (this.uiMode === 'selecting') {
      for (const k of this.moveKeys) this.paintTile(g, parseKey(k), COLORS.moveFill, COLORS.moveEdge);

      /* 控制区落点盖在移动范围**之上**：把"能自由走动"和"走到这为止"
         在视觉上分成两段，规则不用解释也看得懂。 */
      for (const k of this.zocStopKeys) this.paintZocTile(g, parseKey(k));
    }

    const attackKeys =
      this.uiMode === 'selecting' ? this.attackPotentialKeys : this.attackNowKeys;
    for (const k of attackKeys) {
      this.paintTile(g, parseKey(k), COLORS.attackFill, COLORS.attackEdge);
    }

    /* 路径预览：光标停在一个可到达的格子上时，画出 Dijkstra 回溯出来的实际路线 */
    const moveRange = this.moveRange;
    const hoverTile = this.hoverTile;
    if (this.uiMode === 'selecting' && moveRange !== null && hoverTile !== null) {
      if (this.moveKeys.has(key(hoverTile))) {
        const path = findPath(moveRange, hoverTile);
        if (path && path.length > 1) {
          g.fillStyle(COLORS.path, 0.9);
          for (const step of path) {
            const c = tileCenter(step.x, step.y);
            g.fillCircle(c.x, c.y, 4.5);
          }
        }
      }
    }
  }

  private drawCursor(): void {
    const g = this.cursorGfx;
    g.clear();
    if (!this.hoverTile) return;
    const px = this.hoverTile.x * TILE;
    const py = this.hoverTile.y * TILE;
    g.lineStyle(3, COLORS.cursor, 0.95);
    g.strokeRect(px + 1.5, py + 1.5, TILE - 3, TILE - 3);
  }

  /* ------------------------------------------------------------ 单位视图 */

  private createUnitView(unit: Unit): UnitView {
    const isPlayer = unit.team === 'player';
    const center = tileCenter(unit.pos.x, unit.pos.y);

    const body = this.add
      .rectangle(0, 0, TILE - 12, TILE - 12, isPlayer ? COLORS.playerBody : COLORS.enemyBody)
      .setStrokeStyle(2, isPlayer ? COLORS.playerEdge : COLORS.enemyEdge);

    const label = this.add
      .text(0, -7, unit.name, {
        fontFamily: FONT,
        fontSize: '15px',
        color: '#0d1018',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    const barWidth = TILE - 18;
    const hpBack = this.add
      .rectangle(0, 19, barWidth, 6, COLORS.hpBack)
      .setOrigin(0.5, 0.5);
    const hpFill = this.add
      .rectangle(-barWidth / 2, 19, barWidth, 6, COLORS.hpHigh)
      .setOrigin(0, 0.5);

    const container = this.add.container(center.x, center.y, [body, label, hpBack, hpFill]);
    container.setDepth(20);

    return { container, hpFill };
  }

  /**
   * 把视图对齐到状态的真相。
   *
   * 位置这里是**直接吸附**的：逐格行走动画由 playMoves 单独播放。
   * 之所以要分开，是因为走路必须沿 Dijkstra 回溯出来的真实路径一格格走，
   * 而不是从起点直线补间到终点 —— 后者会让单位穿过墙壁和水面。
   */
  private updateUnitView(view: UnitView, unit: Unit): void {
    const center = tileCenter(unit.pos.x, unit.pos.y);
    view.container.setPosition(center.x, center.y);

    /* 血条平滑过渡：先杀掉上一次的补间，否则连续两次受伤会互相打架 */
    const ratio = Math.max(0, Math.min(1, unit.hp / unit.maxHp));
    this.tweens.killTweensOf(view.hpFill);
    this.tweens.add({
      targets: view.hpFill,
      scaleX: ratio,
      duration: FX.hpBar,
      ease: 'Quad.easeOut',
    });
    view.hpFill.setFillStyle(
      ratio > 0.6 ? COLORS.hpHigh : ratio > 0.3 ? COLORS.hpMid : COLORS.hpLow,
    );

    /* 已行动的单位压暗，一眼看出还剩谁能动 */
    view.container.setAlpha(unit.done ? 0.45 : 1);
  }

  /**
   * 把视图同步到当前状态。
   *
   * @param collectDeaths 传入数组时，阵亡单位的视图**不销毁**，而是交给调用方
   *   播完阵亡动画再销毁；传 null 表示立即销毁（重开关卡用）。
   */
  private syncUnits(collectDeaths: RemovedView[] | null): void {
    const alive = new Set<string>();

    for (const unit of this.battle.units) {
      if (unit.hp <= 0) continue;
      alive.add(unit.id);

      let view = this.unitViews.get(unit.id);
      if (!view) {
        view = this.createUnitView(unit);
        this.unitViews.set(unit.id, view);
      }
      this.updateUnitView(view, unit);
    }

    /* Map 迭代时删除当前项是安全的 */
    for (const [id, view] of this.unitViews) {
      if (alive.has(id)) continue;
      this.unitViews.delete(id);

      /* 让血条先掉到 0，倒地动画才不至于顶着半管血消失 */
      this.tweens.killTweensOf(view.hpFill);
      this.tweens.add({
        targets: view.hpFill,
        scaleX: 0,
        duration: 180,
        ease: 'Quad.easeOut',
      });

      if (collectDeaths) collectDeaths.push({ id, view });
      else view.container.destroy();
    }
  }

  /* ---------------------------------------------------------------- 输入 */

  private bindInput(): void {
    /* 右键取消 + 屏蔽浏览器右键菜单。
       这两个纯粹是体验增强，缺了不影响游戏能跑，所以用鸭子类型取一次，
       避免将来升级引擎时因为签名变动直接编译失败。 */
    const inputExtras = this.input as unknown as {
      mouse?: { disableContextMenu?: () => void };
    };
    inputExtras.mouse?.disableContextMenu?.();

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      const tile = this.pointerToTile(pointer);
      if (tile === null) return;
      const previous = this.hoverTile;
      if (previous !== null && samePos(previous, tile)) return;
      this.hoverTile = tile;
      this.refresh();
    });

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      /* 浏览器规定音频必须由用户手势唤醒。每次点击都叫一遍是幂等的。 */
      this.audio.unlock();

      /* 演出期间连右键取消也一并吞掉：
         否则玩家能在走位动画播到一半时清掉选择，
         等动画结束时 recomputeHighlights 已经找不到选中单位，UI 会卡在半截状态。 */
      if (this.busy) return;

      const buttons = pointer as unknown as { rightButtonDown?: () => boolean };
      if (buttons.rightButtonDown?.() === true) {
        this.cancelSelection();
        return;
      }
      const tile = this.pointerToTile(pointer);
      this.hoverTile = tile;
      if (tile === null) {
        this.cancelSelection();
        return;
      }
      this.handleTileClick(tile);
    });

    const keyboard = this.input.keyboard;
    if (keyboard) {
      /* 键盘也可能是玩家的第一个手势 */
      keyboard.on('keydown', () => this.audio.unlock());
      keyboard.on('keydown-SPACE', () => this.onSpace());
      keyboard.on('keydown-E', () => this.endPlayerTurn());
      keyboard.on('keydown-M', () => this.toggleMute());
      keyboard.on('keydown-T', () => this.toggleThreat());
      keyboard.on('keydown-ESC', () => this.cancelSelection());
      keyboard.on('keydown-R', () => this.restart());
      /* 换武器。数字键直接选第 N 把，Tab 循环 —— 两个都给，
         因为"我想换成第 2 把"和"我想换一把看看"是两种不同的意图。 */
      keyboard.on('keydown-TAB', () => this.cycleWeapon(1));
      /* Q：循环选择战技（普通攻击 ↔ 各个战技） */
      keyboard.on('keydown-Q', () => this.cycleSkill());
      for (let n = 1; n <= 9; n += 1) {
        keyboard.on(`keydown-${['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'][n - 1]}`, () =>
          this.equipWeaponAt(n - 1),
        );
      }
    }
  }

  /** 把当前选中单位的武器换成携带列表里的第 index 把（数字键用） */
  private equipWeaponAt(index: number): void {
    const unit = this.inspectedUnit();
    if (unit === null || this.busy) return;
    const weapon = unit.weapons[index];
    if (weapon === undefined || weapon.id === unit.weapon.id) {
      /* 换了也没变化 —— 给个否定音，让"按了但没用"和不按有区别 */
      if (weapon !== undefined) this.audio.play('deny');
      return;
    }
    this.audio.play('select');
    this.dispatch({ type: 'equip', unitId: unit.id, weaponId: weapon.id });
  }

  /** Tab：在当前武器的下一把之间循环 */
  private cycleWeapon(step: number): void {
    const unit = this.inspectedUnit();
    if (unit === null || this.busy || unit.weapons.length < 2) return;
    const current = unit.weapons.findIndex((w) => w.id === unit.weapon.id);
    const next = unit.weapons[(current + step + unit.weapons.length) % unit.weapons.length];
    if (next === undefined) return;
    this.equipWeaponAt(unit.weapons.indexOf(next));
  }

  private pointerToTile(pointer: Phaser.Input.Pointer): Vec2 | null {
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const tile: Vec2 = { x: Math.floor(world.x / TILE), y: Math.floor(world.y / TILE) };
    return inBounds(this.battle.map, tile) ? tile : null;
  }

  /**
   * 点击一格该发生什么 —— 全部交给 `resolveClick` 判断。
   *
   * 场景这里只负责「把意图翻译成动作」，一条规则都不写。
   * 规则全在 interaction.ts 里，那边有完整的单测。
   */
  private handleTileClick(tile: Vec2): void {
    /* 演出进行中不接新指令 */
    if (this.busy) return;

    const intent = resolveClick({
      state: this.battle,
      mode: this.uiMode,
      selectedId: this.selectedId,
      tile,
      moveKeys: this.moveKeys,
      attackNowKeys: this.attackNowKeys,
    });

    switch (intent.kind) {
      case 'none':
        return;

      case 'cancel':
        this.cancelSelection();
        return;

      case 'select': {
        const unit = this.battle.units.find((u) => u.id === intent.unitId);
        if (unit) this.selectUnit(unit);
        return;
      }

      case 'move':
        this.audio.play('confirm');
        /* 走完再亮出攻击范围 —— 边走边亮会显得范围"提前跳过去了" */
        this.dispatch({ type: 'move', unitId: intent.unitId, to: intent.to }, () => {
          this.uiMode = 'moved';
          this.recomputeHighlights();
          this.refresh();
        });
        return;

      case 'attack': {
        /* 相克占优时补一个确认音，让"打对了人"这件事有即时听觉反馈 */
        const attacker = this.battle.units.find((u) => u.id === intent.unitId);
        const target = this.battle.units.find((u) => u.id === intent.targetId);

        /* TP 不够就别把动作派出去 —— reducer 会抛错，那对玩家来说就是崩了。
           这里拦下来并给出明确反馈，比让他看到一张红脸好。 */
        const art = attacker === undefined ? null : this.pendingSkill(attacker);
        if (art !== null && attacker !== undefined && art.cost > attacker.tp) {
          this.audio.play('deny');
          return;
        }

        /* 相克占优时补一个确认音，让"打对了人"这件事有即时听觉反馈 */
        if (attacker && target && triangleEdge(attacker, target) === 'advantage') {
          this.audio.play('confirm');
        }
        this.dispatch({
          type: 'attack',
          unitId: intent.unitId,
          targetId: intent.targetId,
          /* 意图本身不带战技（interaction.ts 只管"点了哪一格"），
             由场景把当前选定的战技附上去 */
          ...(art === null ? {} : { skillId: art.id }),
        });
        this.cancelSelection();
        return;
      }

      case 'wait':
        this.dispatch({ type: 'wait', unitId: intent.unitId });
        this.cancelSelection();
        return;

      default: {
        const never: never = intent;
        throw new Error(`未知点击意图：${JSON.stringify(never)}`);
      }
    }
  }

  private onSpace(): void {
    if (this.busy) return;
    const selected = this.selectedUnit();
    if (selected) {
      this.dispatch({ type: 'wait', unitId: selected.id });
      this.cancelSelection();
      return;
    }
    this.endPlayerTurn();
  }

  /** 静音开关。没有视觉反馈的话玩家会以为按键没生效，所以顺带 refresh 一次 HUD。 */
  private toggleMute(): void {
    this.audio.toggleMute();
    this.refresh();
  }

  /** 威胁范围开关。同理，需要一个看得见的状态变化。 */
  private toggleThreat(): void {
    this.showThreat = !this.showThreat;
    this.recomputeThreat();
    this.refresh();
  }

  /** 只在开着的时候算；关着的时候也要清空，否则重开后会残留上一局的区域 */
  private recomputeThreat(): void {
    this.threatKeys = this.showThreat
      ? computeThreatZone(this.battle, 'enemy')
      : new Set<string>();
  }

  /* ------------------------------------------------------------ 选择状态 */

  private selectedUnit(): Unit | null {
    if (this.selectedId === null) return null;
    const unit = this.battle.units.find((u) => u.id === this.selectedId);
    if (!unit || unit.hp <= 0 || unit.done) return null;
    return unit;
  }

  /**
   * 选中的单位，**不管它有没有行动完** —— 查看、换武器、选战技都要用它。
   *
   * ⚠️ 别把它和 `selectedUnit()` 混用。`selectedUnit()` 的语义是"这个单位还能不能接受指令"，
   * 用它去取"当前在看的单位"会让所有针对已行动单位的功能静默失效 ——
   * 我就在这上面栽过一次：上一版"打完还能换武器"因此根本没生效，
   * 因为 `equipWeaponAt` 拿到的是 null，然后一声不响地 return 了。
   */
  private inspectedUnit(): Unit | null {
    if (this.selectedId === null) return null;
    const unit = this.battle.units.find((u) => u.id === this.selectedId);
    return !unit || unit.hp <= 0 ? null : unit;
  }

  /** 当前打算用的战技。没有就是普通攻击 */
  private pendingSkill(unit: Unit): SkillDef | null {
    if (this.pendingSkillId === null) return null;
    return unit.skills.find((s) => s.id === this.pendingSkillId) ?? null;
  }

  /**
   * `Q`：在「普通攻击 → 各个战技」之间循环。
   *
   * ⚠️ **即使一个战技都买不起，也要照常循环。**
   * 早先的写法是"没得选就放个否定音直接返回"，结果 TP 不够时按 Q
   * 界面上**完全没有任何变化** —— 玩家只会认为功能坏了（我第一反应就是这样）。
   * 现在照常切，切到买不起的会在侧边栏标红提示，并按需要禁止真的打出去。
   */
  private cycleSkill(): void {
    const unit = this.inspectedUnit();
    if (unit === null || this.busy) return;

    if (unit.skills.length === 0) {
      this.audio.play('deny');
      return;
    }

    const options: (SkillDef | null)[] = [null, ...unit.skills];
    const current = options.findIndex((s) => s !== null && s.id === this.pendingSkillId);
    const next = options[(current + 1) % options.length] ?? null;
    this.pendingSkillId = next?.id ?? null;

    /* 买不起也让你选，但用声音明确告诉你"这个现在还不行" */
    this.audio.play(next !== null && next.cost > unit.tp ? 'deny' : 'select');
    this.refresh();
  }

  private selectUnit(unit: Unit): void {
    this.selectedId = unit.id;
    this.uiMode = unit.moved ? 'moved' : 'selecting';
    /* 换单位就清掉待用战技 —— 否则会把上一个单位的战技带过来，
       表现为"点了这个单位却打出另一个单位的招" */
    this.pendingSkillId = null;
    this.audio.play('select');
    this.recomputeHighlights();
    this.refresh();
  }

  private clearSelection(): void {
    this.selectedId = null;
    this.uiMode = 'idle';
    this.moveRange = null;
    this.moveKeys = new Set();
    this.attackNowKeys = new Set();
    this.attackPotentialKeys = new Set();
    this.zocStopKeys = new Set();
  }

  private cancelSelection(): void {
    this.clearSelection();
    this.refresh();
  }

  private recomputeHighlights(): void {
    const highlights = computeHighlights(this.battle, this.selectedUnit());
    this.moveRange = highlights.moveRange;
    this.moveKeys = highlights.moveKeys;
    this.attackNowKeys = highlights.attackNowKeys;
    this.attackPotentialKeys = highlights.attackPotentialKeys;
    this.zocStopKeys = highlights.zocStopKeys;
  }

  /* ---------------------------------------------------------------- 派发 */

  /**
   * 唯一的「改状态 + 演出」入口。
   *
   * 顺序是刻意的：
   *   1. 先让 core 算出新状态 —— 真相永远以 core 为准，不预测、不猜测
   *   2. 拿「前后两个状态」推导该演什么（纯函数，见 feedback.ts）
   *   3. 把新状态落到画面上（视图吸附到新位置、血条开始过渡）
   *   4. 最后叠加动画
   *
   * 第 3、4 步在同一个同步块里完成，浏览器只会渲染一次，
   * 所以「先吸附到终点、再倒回起点开始逐格走」看不到任何闪烁。
   */
  private dispatch(action: Action, onDone?: () => void): void {
    if (this.busy) return;

    const before = this.battle;
    let after: BattleState;
    try {
      after = applyAction(before, action);
    } catch (error) {
      /* 走到这里说明有 bug（UI 应该在派发前就挡住非法操作） */
      console.error('[非法操作]', action, error);
      this.audio.play('deny');
      this.cameras.main.shake(110, 0.004);
      onDone?.();
      return;
    }

    const feedback = buildFeedback(before, after, action);
    this.battle = after;
    /* 单位动了/死了，威胁范围就变了。只在开着时才有开销。 */
    this.recomputeThreat();
    /* 这里存的是**真相**（core 算出来的状态），不是画面上的中间态 */
    this.onStateChange(this.battle);

    const removed: RemovedView[] = [];
    this.syncUnits(removed);
    this.refresh();

    this.busy = true;
    this.playFeedback(feedback, removed, () => {
      this.busy = false;
      this.refresh();
      onDone?.();
    });
  }

  /* ---------------------------------------------------------------- 演出 */

  private playFeedback(
    feedback: Feedback,
    removed: RemovedView[],
    onDone: () => void,
  ): void {
    const moves = feedback.events.filter(
      (e): e is Extract<FxEvent, { kind: 'move' }> => e.kind === 'move',
    );
    const strikes = feedback.events.filter(isStrikeFx);
    const rewards = feedback.events.filter(
      (e): e is Extract<FxEvent, { kind: 'exp' | 'levelup' }> =>
        e.kind === 'exp' || e.kind === 'levelup',
    );
    const phase = feedback.events.find((e) => e.kind === 'phase');
    const outcome = feedback.events.find((e) => e.kind === 'outcome');
    const inCombat = feedback.combat !== null && strikes.length > 0;

    const banner = (): void => {
      if (outcome?.kind === 'outcome') {
        this.audio.play(outcome.phase === 'won' ? 'win' : 'lose');
        this.onBanner(
          outcome.phase === 'won' ? '我方胜利' : '我方全灭',
          outcome.phase === 'won' ? 'ENEMY ROUTED' : 'DEFEAT',
          outcome.phase,
        );
        /* 只在这里通知一次结算 —— playFeedback 每次派发只跑一次 outcome 分支 */
        this.onOutcome({
          phase: outcome.phase,
          turns: this.battle.turn,
          survivors: livingUnitsOf(this.battle, 'player').length,
        });
        return;
      }
      if (phase?.kind === 'phase') {
        this.audio.play('phase');
        this.onBanner(`第 ${phase.turn} 回合`, `${teamLabel(phase.team)}阶段`, 'neutral');
      }
    };

    const finish = (): void => {
      /* 经验与升级排在打击之后、横幅之前：先打完再结算，
         玩家看到的因果链才和 core 里的结算顺序一致。 */
      this.playRewards(rewards, () => {
        banner();
        this.resetCamera();
        /* 刚运镜过的，等镜头退回原位再放行下一步，否则下一次推进会把镜头拽歪 */
        if (inCombat) this.time.delayedCall(FX.cameraBack, onDone);
        else onDone();
      });
    };

    if (moves.length > 0) {
      this.playMoves(moves, finish);
      return;
    }
    if (inCombat && feedback.combat) {
      this.playCombat(feedback.combat, strikes, removed, finish);
      return;
    }
    /* 待机 / 结束回合之类：没有位移也没有交战，播阵亡和横幅就够了 */
    this.playDeaths(removed, finish);
  }

  /**
   * 播放经验飘字与升级演出。
   *
   * 经验飘字做得最轻最淡（它每次交战都出现），升级则相反：
   * 金色标题 + 弹一下 + 属性明细 + 专属音效，它是这一整块机制里唯一的高光。
   */
  private playRewards(
    rewards: Extract<FxEvent, { kind: 'exp' | 'levelup' }>[],
    onDone: () => void,
  ): void {
    if (rewards.length === 0) {
      onDone();
      return;
    }

    let pending = rewards.length;
    let delay = 0;

    const one = (): void => {
      pending -= 1;
      if (pending <= 0) onDone();
    };

    for (const reward of rewards) {
      this.time.delayedCall(delay, () => {
        this.fx.floatText(reward.pos, `+${reward.amount} EXP`, 'exp');

        if (reward.kind === 'exp') {
          one();
          return;
        }

        this.audio.play('levelup');
        this.fx.levelUp(reward.pos, gainsText(reward.gains));
        /* 升级要多停一拍，否则属性明细还没看清就被下一步冲掉了 */
        this.time.delayedCall(FX.levelUpHold, one);
      });
      delay += FX.rewardGap;
    }
  }

  private playMoves(
    moves: Extract<FxEvent, { kind: 'move' }>[],
    onDone: () => void,
  ): void {
    let pending = moves.length;
    const one = (): void => {
      pending -= 1;
      if (pending <= 0) onDone();
    };

    for (const move of moves) {
      const view = this.unitViews.get(move.unitId);
      if (!view) {
        one();
        continue;
      }
      this.walkAlong(view, move.path, one);
    }
  }

  /**
   * 沿路径逐格行走。
   * path[0] 是起点 —— 视图先被拉回那里，再一格格走到终点。
   */
  private walkAlong(view: UnitView, path: Vec2[], onDone: () => void): void {
    const start = tileCenter(path[0].x, path[0].y);
    view.container.setPosition(start.x, start.y);

    let index = 1;
    const step = (): void => {
      if (index >= path.length) {
        onDone();
        return;
      }
      const center = tileCenter(path[index].x, path[index].y);
      index += 1;
      this.tweens.add({
        targets: view.container,
        x: center.x,
        y: center.y,
        duration: FX.movePerTile,
        ease: 'Linear',
        onComplete: step,
      });
    };
    step();
  }

  private playCombat(
    combat: { attackerId: string; targetId: string },
    strikes: StrikeFx[],
    removed: RemovedView[],
    onDone: () => void,
  ): void {
    const dead = new Map(removed.map((r) => [r.id, r.view] as const));
    const viewOf = (id: string): UnitView | undefined =>
      this.unitViews.get(id) ?? dead.get(id);

    const attackerView = viewOf(combat.attackerId);
    const targetView = viewOf(combat.targetId);
    this.focusCamera(attackerView, targetView);

    let index = 0;
    const nextStrike = (): void => {
      if (index >= strikes.length) {
        this.playDeaths(removed, onDone);
        return;
      }

      const strike = strikes[index];
      index += 1;

      const victimView = viewOf(strike.unitId);
      /* 这一下的出手方是"另一边"：受害者是攻方，说明这是反击 */
      const strikerView = strike.unitId === combat.attackerId ? targetView : attackerView;

      const impact = (): void => {
        if (strike.kind === 'miss') {
          this.audio.play('miss');
          this.fx.floatText(strike.pos, 'MISS', 'miss');
          return;
        }

        const isCrit = strike.kind === 'crit';
        /* 击杀音优先：击杀本身已经是最强的反馈，再叠会心音反而糊 */
        this.audio.play(strike.lethal ? 'lethal' : isCrit ? 'crit' : 'hit');

        const tone = strike.lethal ? 'lethal' : isCrit ? 'crit' : 'damage';
        this.fx.floatText(strike.pos, `-${strike.amount}`, tone);
        this.fx.impact(strike.pos, tone);
        if (victimView) this.fx.hitShake(victimView.container, isCrit ? 13 : 8);

        const shake = strike.lethal ? 0.007 : isCrit ? 0.009 : 0.004;
        this.cameras.main.shake(strike.lethal || isCrit ? 150 : 90, shake);
      };

      this.lunge(strikerView, victimView, impact, () => {
        this.time.delayedCall(FX.strikeGap, nextStrike);
      });
    };

    nextStrike();
  }

  /** 突进再退回。结束时精确回到原位，不会把单位挪歪。 */
  private lunge(
    striker: UnitView | undefined,
    victim: UnitView | undefined,
    impact: () => void,
    onDone: () => void,
  ): void {
    if (!striker || !victim) {
      impact();
      onDone();
      return;
    }

    const target = striker.container;
    const originX = target.x;
    const originY = target.y;
    const dx = victim.container.x - originX;
    const dy = victim.container.y - originY;
    const length = Math.hypot(dx, dy) || 1;
    const reach = TILE * 0.3;

    this.audio.play('whoosh');
    this.tweens.add({
      targets: target,
      x: originX + (dx / length) * reach,
      y: originY + (dy / length) * reach,
      duration: FX.lunge,
      ease: 'Quad.easeOut',
      onComplete: () => {
        impact();
        this.tweens.add({
          targets: target,
          x: originX,
          y: originY,
          duration: FX.lunge,
          ease: 'Quad.easeIn',
          onComplete: onDone,
        });
      },
    });
  }

  private playDeaths(removed: RemovedView[], onDone: () => void): void {
    if (removed.length === 0) {
      onDone();
      return;
    }
    let pending = removed.length;
    for (const { view } of removed) {
      this.fx.death(view.container, () => {
        pending -= 1;
        if (pending <= 0) onDone();
      });
    }
  }

  private focusCamera(a: UnitView | undefined, b: UnitView | undefined): void {
    if (!a || !b) return;
    const cam = this.cameras.main;
    cam.pan(
      (a.container.x + b.container.x) / 2,
      (a.container.y + b.container.y) / 2,
      FX.cameraPan,
      'Quad.easeOut',
      true,
    );
    cam.zoomTo(FX.cameraZoom, FX.cameraPan, 'Quad.easeOut', true);
  }

  private resetCamera(): void {
    const center = mapCenter(this.battle.map.width, this.battle.map.height);
    const cam = this.cameras.main;
    cam.pan(center.x, center.y, FX.cameraBack, 'Quad.easeOut', true);
    cam.zoomTo(1, FX.cameraBack, 'Quad.easeOut', true);
  }

  /* ------------------------------------------------------------ 回合流转 */

  private endPlayerTurn(): void {
    if (this.busy) return;
    if (this.battle.phase !== 'playing') return;
    if (this.battle.activeTeam !== 'player') return;

    this.clearSelection();
    this.refresh();
    /* 等「敌方阶段」横幅演一会儿再开跑，否则 AI 的第一步会盖在转场下面 */
    this.dispatch({ type: 'endTurn' }, () => {
      this.time.delayedCall(FX.bannerHold, () => this.runEnemyPhase());
    });
  }

  /**
   * 播放敌方阶段。
   *
   * 关键：**先把整轮计划算完，再逐条播放动画**。
   * AI 的思考是不带延迟的纯计算，动画只是事后演示，
   * 绝不会出现"动画回调里改了状态导致 AI 决策漂移"的经典 bug。
   *
   * 加入异步演出后这里必须改成**串行**：每一步的动画播完才派发下一步。
   * 原来固定间隔的 delayedCall 会让突进动画互相重叠。
   */
  private runEnemyPhase(): void {
    if (this.battle.phase !== 'playing') return;

    const runId = this.runId;
    const plan = planTurn(this.battle, 'enemy');
    let index = 0;

    const step = (): void => {
      /* 玩家中途按了 R 重开：这一轮计划已经作废，必须停手 */
      if (runId !== this.runId) return;
      if (this.battle.phase !== 'playing' || this.battle.activeTeam !== 'enemy') {
        this.refresh();
        return;
      }
      if (index >= plan.length) {
        this.refresh();
        return;
      }

      const action = plan[index];
      index += 1;
      this.dispatch(action, () => this.time.delayedCall(FX.aiGap, step));
    };

    step();
  }

  private restart(): void {
    /* 自增代号会让还在跑的敌方阶段计划和所有动画回调全部作废 */
    this.runId += 1;
    this.busy = false;
    this.tweens.killAll();
    this.fx.clear();

    this.battle = this.initial;
    /* 重开也要通知外层，否则中途存档里留的还是重开前的残局 */
    this.onStateChange(this.battle);
    for (const view of this.unitViews.values()) view.container.destroy();
    this.unitViews.clear();

    this.clearSelection();
    this.syncUnits(null);
    this.recomputeThreat();
    this.resetCamera();
    this.refresh();
  }

  /* ------------------------------------------------------------------ HUD */

  private refresh(): void {
    this.drawOverlay();
    this.drawCursor();
    this.pushHud();
  }

  private hintText(): string {
    if (this.battle.phase === 'won') return '战斗胜利——按 R 重开';
    if (this.battle.phase === 'lost') return '我方全灭——按 R 重开';
    if (this.battle.activeTeam === 'enemy') return '敌方行动中…';

    /* 光标停在控制区落点上时**优先**解释这一条 ——
       玩家此刻最想知道的就是"我为什么走不到那边"。 */
    const hover = this.hoverTile;
    if (this.uiMode === 'selecting' && hover !== null && this.zocStopKeys.has(key(hover))) {
      return '琥珀色：踏进去移动就结束（敌方控制区）';
    }

    if (this.uiMode === 'selecting') {
      return this.zocStopKeys.size > 0
        ? '点蓝格移动、点红格内的敌人攻击；琥珀色格子走进去会停下'
        : '点蓝格移动，或直接点红格内的敌人攻击';
    }
    if (this.uiMode === 'moved') return '点红格内的敌人攻击，或按 Space 待机';

    /* 选中了带战技的单位时，把 Q 提示出来 —— 否则玩家根本不知道有这个功能
       （实测就是这样：功能做了、键也绑了，但没人告诉他） */
    const picked = this.inspectedUnit();
    if (picked !== null && picked.skills.length > 0) {
      const art = this.pendingSkill(picked);
      if (art === null) return '按 Q 切换战技（当前：普通攻击）';
      return art.cost > picked.tp
        ? `【${art.name}】TP 不足（${picked.tp}/${art.cost}）—— 按 Q 换别的`
        : `当前战技：【${art.name}】消耗 ${art.cost} TP，不能追击`;
    }

    if (livingUnitsOf(this.battle, 'player').every((u) => u.done)) {
      return '我方全部行动完毕——按 E 结束回合';
    }
    return '点击我方单位以选择';
  }

  private hoveredTerrain(hoverTile: Vec2 | null): TerrainDef | null {
    if (hoverTile === null) return null;
    return terrainAt(this.battle.map, hoverTile);
  }

  /**
   * 构造战斗预测。
   * 如果敌人当前打不到，就在移动范围里找一个"打过去最划算"的落点来预测。
   */
  private buildForecast(
    selected: Unit,
    target: Unit,
  ): { forecast: CombatForecast; from: Vec2 } | null {
    /* 预览必须带上"当前打算用的战技"，否则玩家看到的伤害不是实际会发生的 */
    const art = this.pendingSkill(selected) ?? undefined;

    if (canReach(selected, target)) {
      return { forecast: forecast(this.battle.map, selected, target, art), from: selected.pos };
    }
    if (!this.moveRange) return null;

    let best: { forecast: CombatForecast; from: Vec2 } | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const dest of reachableTiles(this.moveRange)) {
      const simulated: Unit = { ...selected, pos: dest };
      if (!canReach(simulated, target)) continue;

      const f = forecast(this.battle.map, simulated, target, art);
      const score = f.attacker.damage - (f.counter?.damage ?? 0);
      if (score > bestScore) {
        bestScore = score;
        best = { forecast: f, from: dest };
      }
    }
    return best;
  }

  private pushHud(): void {
    const selected = this.selectedUnit();
    const hoverTile = this.hoverTile;
    const hoveredUnit: Unit | null =
      hoverTile === null ? null : (unitAt(this.battle.units, hoverTile) ?? null);

    let built: { forecast: CombatForecast; from: Vec2 } | null = null;
    let forecastTarget: Unit | null = null;

    if (selected && hoveredUnit && hoveredUnit.team !== selected.team && hoveredUnit.hp > 0) {
      const k = key(hoveredUnit.pos);
      /* 必须和 resolveClick 用同一套格子：
         selecting 阶段还可以"移过去再打"，所以看 attackPotentialKeys；
         一旦位置定下来（moved），只有 attackNowKeys 才真的点得动。
         不一致的话会出现「侧边栏显示了战斗预测、点下去却变成待机」。 */
      const clickableKeys =
        this.uiMode === 'selecting' ? this.attackPotentialKeys : this.attackNowKeys;
      if (clickableKeys.has(k)) {
        built = this.buildForecast(selected, hoveredUnit);
        if (built) forecastTarget = hoveredUnit;
      }
    }

    this.onHud({
      turn: this.battle.turn,
      activeTeam: this.battle.activeTeam,
      phase: this.battle.phase,
      objective: this.battle.objective,
      /* 战技是纯 UI 状态，得从场景传过去 */
      pendingSkill: (() => {
        const unit = this.inspectedUnit();
        return unit === null ? null : this.pendingSkill(unit);
      })(),
      playerAlive: livingUnitsOf(this.battle, 'player').length,
      enemyAlive: livingUnitsOf(this.battle, 'enemy').length,
      selected,
      hoveredUnit,
      hoverTerrain: this.hoveredTerrain(hoverTile),
      forecast: built?.forecast ?? null,
      forecastFrom: built?.from ?? null,
      forecastTarget,
      log: this.battle.log,
      hint: this.hintText(),
      muted: this.audio.muted,
      showThreat: this.showThreat,
    });
  }
}
