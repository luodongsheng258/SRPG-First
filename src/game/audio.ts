/**
 * 音效层 —— 全部用 WebAudio 现场合成，不需要任何素材文件。
 *
 * 对独立开发来说这是实打实的好处：
 *   - 不用找素材、不用管授权、不用管格式转换
 *   - 包体一个字节都不增加
 *   - 想换音色就是改一个数字，不用重新导出
 *   - 素材文件天生没法做单元测试，而这张配方表可以
 *
 * 结构上刻意拆成两半：
 *   - `SFX` 是一张**纯数据**配方表，导入它不碰任何浏览器 API，能在 Node 里断言
 *   - `createAudio()` 是唯一的播放器，负责把配方翻译成 WebAudio 调用
 *
 * 注意：这里的 `Math.random()` 用来生成白噪声，是允许的
 * —— core 层的"禁止 Math.random"是为了保证对局可复现，音效跟对局无关。
 */

/* ------------------------------------------------------------------ 配方表 */

export type SfxName =
  | 'select'
  | 'confirm'
  | 'whoosh'
  | 'hit'
  | 'crit'
  | 'lethal'
  | 'miss'
  | 'phase'
  | 'levelup'
  | 'win'
  | 'lose'
  | 'deny';

export interface ToneSpec {
  wave: OscillatorType;
  /** 起始频率（Hz） */
  freq: number;
  /** 结束频率；给了就做滑音 */
  to?: number;
  /** 时长（秒） */
  dur: number;
  /** 峰值音量，0~1 */
  gain: number;
  /** 相对本次发声起点的延迟（秒），用来拼简单的琶音 */
  delay?: number;
}

export interface NoiseSpec {
  /** 带通中心频率（Hz） */
  freq: number;
  /** 结束频率；给了就做扫频 */
  to?: number;
  /** 带通 Q 值，越大越"哨" */
  q?: number;
  dur: number;
  gain: number;
  delay?: number;
}

export interface SfxRecipe {
  tones?: readonly ToneSpec[];
  noise?: readonly NoiseSpec[];
}

/**
 * 音色设计思路：
 *   - 选中/确认 —— 短促的三角波上扬，清脆不刺耳
 *   - 突进       —— 带通噪声下扫，就是"呼"的一声
 *   - 命中       —— 噪声冲击 + 方波低频下坠，给打击感
 *   - 击杀       —— 同一个思路但更重更长，再补一段锯齿波下坠收尾
 *   - 落空       —— 高频窄带噪声上扫，像金属擦过空气
 *   - 阶段/胜利  —— 三角波琶音，最不容易听腻
 *   - 失败       —— 锯齿波长下滑
 *   - 拒绝       —— 低沉双短音，一听就知道"不行"
 */
export const SFX: Record<SfxName, SfxRecipe> = {
  select: {
    tones: [
      { wave: 'triangle', freq: 640, to: 960, dur: 0.07, gain: 0.16 },
      { wave: 'triangle', freq: 960, dur: 0.05, gain: 0.08, delay: 0.05 },
    ],
  },

  confirm: {
    tones: [
      { wave: 'sine', freq: 520, dur: 0.06, gain: 0.15 },
      { wave: 'sine', freq: 780, dur: 0.1, gain: 0.13, delay: 0.05 },
    ],
  },

  whoosh: {
    noise: [{ freq: 1200, to: 260, q: 0.9, dur: 0.13, gain: 0.1 }],
  },

  hit: {
    noise: [{ freq: 1500, to: 320, q: 1.1, dur: 0.11, gain: 0.2 }],
    tones: [{ wave: 'square', freq: 190, to: 80, dur: 0.11, gain: 0.16 }],
  },

  /* 会心：在命中的基础上叠一层高频"脆响"和一段明亮的三角波，
     听感上明显更"贵"，但要压得住 —— 它比击杀轻、比普通命中重。 */
  crit: {
    noise: [
      { freq: 1800, to: 400, q: 1.1, dur: 0.13, gain: 0.22 },
      { freq: 3200, to: 1200, q: 2, dur: 0.1, gain: 0.12, delay: 0.02 },
    ],
    tones: [
      { wave: 'square', freq: 240, to: 90, dur: 0.14, gain: 0.18 },
      { wave: 'triangle', freq: 988, dur: 0.2, gain: 0.14, delay: 0.04 },
    ],
  },

  lethal: {
    noise: [{ freq: 1800, to: 240, q: 1.2, dur: 0.2, gain: 0.26 }],
    tones: [
      { wave: 'square', freq: 200, to: 60, dur: 0.18, gain: 0.2 },
      { wave: 'sawtooth', freq: 420, to: 70, dur: 0.42, gain: 0.16, delay: 0.08 },
    ],
  },

  miss: {
    noise: [{ freq: 2600, to: 4200, q: 2.2, dur: 0.08, gain: 0.08 }],
  },

  phase: {
    tones: [
      { wave: 'triangle', freq: 523, dur: 0.16, gain: 0.13 },
      { wave: 'triangle', freq: 659, dur: 0.16, gain: 0.13, delay: 0.1 },
      { wave: 'triangle', freq: 784, dur: 0.2, gain: 0.13, delay: 0.2 },
    ],
  },

  /* 升级：三个上行纯音。
     刻意**一个噪声都不加** —— 战斗音全是噪声底，
     升级用干净的三角波才跳得出来，一耳朵就知道"这是好事"。 */
  levelup: {
    tones: [
      { wave: 'triangle', freq: 659, dur: 0.12, gain: 0.14 },
      { wave: 'triangle', freq: 830, dur: 0.12, gain: 0.14, delay: 0.09 },
      { wave: 'triangle', freq: 988, dur: 0.3, gain: 0.16, delay: 0.18 },
    ],
  },

  win: {
    tones: [
      { wave: 'triangle', freq: 523, dur: 0.18, gain: 0.15 },
      { wave: 'triangle', freq: 659, dur: 0.18, gain: 0.15, delay: 0.1 },
      { wave: 'triangle', freq: 784, dur: 0.18, gain: 0.15, delay: 0.2 },
      { wave: 'triangle', freq: 1046, dur: 0.36, gain: 0.17, delay: 0.3 },
    ],
  },

  lose: {
    tones: [
      { wave: 'sawtooth', freq: 392, to: 196, dur: 0.55, gain: 0.15 },
      { wave: 'sawtooth', freq: 294, to: 147, dur: 0.7, gain: 0.13, delay: 0.12 },
    ],
  },

  deny: {
    tones: [
      { wave: 'square', freq: 165, dur: 0.09, gain: 0.14 },
      { wave: 'square', freq: 123, dur: 0.12, gain: 0.14, delay: 0.08 },
    ],
  },
};

export const SFX_NAMES = Object.keys(SFX) as SfxName[];

/* -------------------------------------------------------------------- 播放 */

/** 包络：极短的起音 + 指数衰减。指数衰减最接近真实的敲击/拨弦。 */
function applyEnvelope(param: AudioParam, start: number, dur: number, peak: number): void {
  const attack = Math.min(0.006, dur * 0.2);
  param.setValueAtTime(0.0001, start);
  param.linearRampToValueAtTime(peak, start + attack);
  param.exponentialRampToValueAtTime(0.0001, start + dur);
}

/** 白噪声缓冲。只生成一次，所有噪声事件共用。 */
function buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const frames = Math.floor(ctx.sampleRate * 0.5);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

export interface Audio {
  /**
   * 浏览器规定音频必须由用户手势唤醒。
   * 场景在第一次点击/按键时调一次，之后就能随便放了。
   */
  unlock(): void;
  play(name: SfxName): void;
  /** @returns 切换后的静音状态 */
  toggleMute(): boolean;
  readonly muted: boolean;
}

export function createAudio(options: { volume?: number } = {}): Audio {
  const volume = options.volume ?? 0.5;

  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let muted = false;

  /** 首次调用时建上下文；之后只负责把挂起的上下文唤醒 */
  function ensure(): boolean {
    if (typeof window === 'undefined') return false;

    if (ctx === null) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return false;

      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : volume;
      master.connect(ctx.destination);
      noiseBuffer = buildNoiseBuffer(ctx);
    }

    if (ctx.state === 'suspended') void ctx.resume();
    return true;
  }

  function play(name: SfxName): void {
    if (muted) return;
    if (!ensure()) return;

    /* 先把可能为 null 的闭包变量抄进 const 局部量：
       `ctx` / `master` 是外层 let，在多次函数调用之后 TypeScript 会
       取消对它们的收窄，直接往下用会报"可能为 null"。抄成 const 就稳了。 */
    const context = ctx;
    const out = master;
    const noise = noiseBuffer;
    if (context === null || out === null || noise === null) return;

    const recipe = SFX[name];
    const now = context.currentTime;

    for (const tone of recipe.tones ?? []) {
      const start = now + (tone.delay ?? 0);
      const osc = context.createOscillator();
      const gain = context.createGain();

      osc.type = tone.wave;
      osc.frequency.setValueAtTime(tone.freq, start);
      if (tone.to !== undefined) {
        /* 指数滑音听感更自然，但值必须为正 */
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, tone.to), start + tone.dur);
      }
      applyEnvelope(gain.gain, start, tone.dur, tone.gain);

      osc.connect(gain).connect(out);
      osc.start(start);
      osc.stop(start + tone.dur + 0.05);
    }

    for (const spec of recipe.noise ?? []) {
      const start = now + (spec.delay ?? 0);
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();

      source.buffer = noise;
      filter.type = 'bandpass';
      filter.Q.value = spec.q ?? 1;
      filter.frequency.setValueAtTime(spec.freq, start);
      if (spec.to !== undefined) {
        filter.frequency.exponentialRampToValueAtTime(Math.max(1, spec.to), start + spec.dur);
      }
      applyEnvelope(gain.gain, start, spec.dur, spec.gain);

      source.connect(filter).connect(gain).connect(out);
      source.start(start);
      source.stop(start + spec.dur + 0.05);
    }
  }

  function unlock(): void {
    ensure();
  }

  function toggleMute(): boolean {
    muted = !muted;
    /* 用 setTargetAtTime 而不是直接赋值：直接赋值会让正在响的音爆一下 */
    if (ctx !== null && master !== null) {
      master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.01);
    }
    return muted;
  }

  return {
    unlock,
    play,
    toggleMute,
    get muted(): boolean {
      return muted;
    },
  };
}
