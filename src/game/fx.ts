import Phaser from 'phaser';

import type { Vec2 } from '../core';
import { FONT, TILE, tileCenter } from './theme';

/**
 * 演出节奏。所有时间都集中在这里，调手感只改这一段。
 *
 * 注意单位是毫秒。总时长是按「一次两段交战」估的：
 *   运镜 220 + 突进 110×2 + 命中 150 + 再突进 110×2 + 命中 150 + 复位 240 ≈ 1.2 秒
 * 敌方阶段每个动作之后还会补一个 aiGap，免得看着像快进。
 */
export const FX = {
  /** 逐格行走：每格耗时 */
  movePerTile: 105,
  /** 血条过渡 */
  hpBar: 260,
  /** 突进单程 */
  lunge: 110,
  /** 两次打击之间的间隔 */
  strikeGap: 150,
  /** 镜头推进/复位 */
  cameraPan: 220,
  cameraBack: 240,
  /** 交战时的镜头放大倍数 */
  cameraZoom: 1.5,
  /** 敌方阶段动作之间的停顿 */
  aiGap: 130,
  /** 换阶段后，等横幅演一会儿再开跑 AI，否则第一步会盖在转场下面 */
  bannerHold: 700,
  /** 阵亡动画 */
  death: 400,
  /** 飘字上升距离与存活时间 */
  textRise: 40,
  textLife: 720,
  /** 经验飘字之间的间隔（攻方先飘、守方后飘，错开才不会叠在一起） */
  rewardGap: 300,
  /** 升级演出要停多久才放行下一步。它是里程碑，值得多停一拍 */
  levelUpHold: 1100,
} as const;

/** 飘字的语气 */
export type FloatTone = 'damage' | 'crit' | 'lethal' | 'miss' | 'exp';

/**
 * 飘字的配色与字号。
 * 用查表而不是嵌套三元 —— 多种语气乘两个属性，三元表达式会变得没法读。
 */
const TONE_STYLE: Record<FloatTone, { color: string; size: number; ring: number }> = {
  damage: { color: '#ffe28a', size: 23, ring: 0xffe28a },
  /* 会心用金色、更大一号 —— 它是战斗里唯一的高光时刻 */
  crit: { color: '#ffd24a', size: 30, ring: 0xffd24a },
  lethal: { color: '#ff7a6b', size: 28, ring: 0xff7a6b },
  miss: { color: '#b9c2d6', size: 20, ring: 0xb9c2d6 },
  /* 经验刻意做得最轻最淡：它每次交战都会出现，抢眼就变成噪音了 */
  exp: { color: '#9fd8ff', size: 15, ring: 0x9fd8ff },
};

const COLOR_STROKE = '#0b0d13';

/**
 * 临时特效层。
 *
 * 自己记着所有还在飞的 GameObject，这样重开关卡时能一次性清干净
 * —— 否则「按 R 重开后残留一堆飘字」这类 bug 会很难查。
 */
export class FxLayer {
  private readonly scene: Phaser.Scene;
  private readonly transient: Phaser.GameObjects.GameObject[] = [];
  private floatIndex = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  clear(): void {
    for (const obj of this.transient) obj.destroy();
    this.transient.length = 0;
    this.floatIndex = 0;
  }

  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.transient.push(obj);
    return obj;
  }

  private untrack(obj: Phaser.GameObjects.GameObject): void {
    obj.destroy();
    const at = this.transient.indexOf(obj);
    if (at >= 0) this.transient.splice(at, 1);
  }

  /** 伤害 / 会心 / MISS 飘字。连续多段打击会左右错开，避免叠在一起看不清。 */
  floatText(pos: Vec2, text: string, tone: FloatTone): void {
    const style = TONE_STYLE[tone];
    const center = tileCenter(pos.x, pos.y);
    const jitter = (this.floatIndex % 3) - 1;
    this.floatIndex += 1;

    const label = this.track(
      this.scene.add
        .text(center.x + jitter * 13, center.y - 8, text, {
          fontFamily: FONT,
          fontSize: `${style.size}px`,
          color: style.color,
          fontStyle: 'bold',
          stroke: COLOR_STROKE,
          strokeThickness: 4,
        })
        .setOrigin(0.5)
        .setDepth(60),
    );

    this.scene.tweens.add({
      targets: label,
      y: label.y - FX.textRise,
      alpha: { from: 1, to: 0 },
      duration: FX.textLife,
      ease: 'Quad.easeOut',
      onComplete: () => this.untrack(label),
    });
  }

  /** 受击抖动。yoyo + repeat 保证结束时回到原位，不会把单位挪歪。 */
  hitShake(target: Phaser.GameObjects.Container, strength = 8): void {
    this.scene.tweens.add({
      targets: target,
      x: target.x + strength,
      duration: 55,
      yoyo: true,
      repeat: 2,
      ease: 'Sine.easeInOut',
    });
  }

  /**
   * 升级：金色 "LEVEL UP" + 一条涨了什么的副标题。
   *
   * 刻意做成**两行**而不是一个长字符串：属性涨了什么比"升级了"这个事实更重要，
   * 挤在一行里字号只能缩到看不清。
   */
  levelUp(pos: Vec2, gains: string): void {
    const center = tileCenter(pos.x, pos.y);

    const title = this.track(
      this.scene.add
        .text(center.x, center.y - 34, 'LEVEL UP', {
          fontFamily: FONT,
          fontSize: '24px',
          color: '#ffd24a',
          fontStyle: 'bold',
          stroke: COLOR_STROKE,
          strokeThickness: 5,
        })
        .setOrigin(0.5)
        .setDepth(65)
        .setScale(0.4),
    );

    /* 先弹一下再飘走：单纯的飘字太安静，压不住它是个里程碑这件事 */
    this.scene.tweens.add({
      targets: title,
      scale: 1,
      duration: 220,
      ease: 'Back.easeOut',
    });
    this.scene.tweens.add({
      targets: title,
      y: title.y - FX.textRise * 0.6,
      alpha: { from: 1, to: 0 },
      delay: 700,
      duration: FX.textLife,
      ease: 'Quad.easeOut',
      onComplete: () => this.untrack(title),
    });

    const detail = this.track(
      this.scene.add
        .text(center.x, center.y - 12, gains, {
          fontFamily: FONT,
          fontSize: '16px',
          color: '#9fe8b0',
          fontStyle: 'bold',
          stroke: COLOR_STROKE,
          strokeThickness: 4,
        })
        .setOrigin(0.5)
        .setDepth(65),
    );

    this.scene.tweens.add({
      targets: detail,
      y: detail.y - FX.textRise * 0.6,
      alpha: { from: 1, to: 0 },
      delay: 700,
      duration: FX.textLife,
      ease: 'Quad.easeOut',
      onComplete: () => this.untrack(detail),
    });
  }

  /** 命中冲击波：一圈快速扩散并淡出的描边。会心时更大更亮。 */
  impact(pos: Vec2, tone: FloatTone): void {
    const style = TONE_STYLE[tone];
    const big = tone === 'crit' || tone === 'lethal';
    const center = tileCenter(pos.x, pos.y);

    const ring = this.track(
      this.scene.add
        .circle(center.x, center.y, TILE * (tone === 'crit' ? 0.26 : 0.2))
        .setStrokeStyle(big ? 4 : 3, style.ring, 0.9)
        .setDepth(55),
    );

    this.scene.tweens.add({
      targets: ring,
      scale: tone === 'crit' ? 2.6 : big ? 2.2 : 1.6,
      alpha: 0,
      duration: big ? 400 : 260,
      ease: 'Quad.easeOut',
      onComplete: () => this.untrack(ring),
    });
  }

  /**
   * 阵亡：淡出 + 缩小 + 倾倒。
   *
   * 容器也进临时表 —— 玩家完全可能在阵亡动画播到一半时按 R 重开，
   * 那一瞬间 tweens.killAll() 不会触发 onComplete，
   * 这个容器就永远留在场景里了（表现为新战场里多出一具尸体）。
   */
  death(container: Phaser.GameObjects.Container, onDone: () => void): void {
    this.scene.tweens.killTweensOf(container);
    this.track(container);
    this.scene.tweens.add({
      targets: container,
      alpha: 0,
      scaleX: 0.55,
      scaleY: 0.55,
      angle: 20,
      y: container.y + 12,
      duration: FX.death,
      ease: 'Quad.easeIn',
      onComplete: () => {
        this.untrack(container);
        onDone();
      },
    });
  }
}

/** 供镜头复位用：地图中心的世界坐标 */
export function mapCenter(width: number, height: number): { x: number; y: number } {
  return { x: (width * TILE) / 2, y: (height * TILE) / 2 };
}
