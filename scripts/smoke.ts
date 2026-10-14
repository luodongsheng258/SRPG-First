/**
 * 浏览器入口冒烟测试。
 *
 *   pnpm smoke
 *
 * **为什么需要它**：有一类故障 Node 单测完全看不见 ——
 * `src/main.ts` 及其依赖在**模块加载期**抛错。
 * 那种情况下的症状极具迷惑性：Vite 开发服务器一切正常、
 * 250+ 个单测全绿、typecheck 干净、build 也能过，
 * 但浏览器里 `main.ts` 一行都没执行，页面只剩下 `index.html` 里
 * 写死的那点静态 DOM（表现为"整页只有一个按钮"）。
 *
 * 这个脚本用一套最小 DOM 桩把 `src/main.ts` 真正 import 一遍，
 * 然后断言菜单**确实渲染出来了**。
 * 它抓不到"长得不对"，但能抓到"根本没跑起来"。
 *
 * ⚠️ 它不能替代浏览器验证：画面、动画、音效仍然只能靠人眼和耳朵。
 */

const noop = (): void => {};

/**
 * 假 2D 上下文。
 *
 * Phaser 在模块加载期就会探测 canvas 能力（`checkInverseAlpha` 之类），
 * 会调 `fillRect` / `getImageData` / `measureText`……
 * 与其一个个补，不如用 Proxy 让它"任何方法都存在、任何属性都可写"。
 */
function fake2dContext(canvas: unknown): any {
  const target: any = {
    canvas,
    fillStyle: '#000',
    strokeStyle: '#000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    getImageData: (_x = 0, _y = 0, w = 1, h = 1) => ({
      data: new Uint8ClampedArray(Math.max(4, w * h * 4)),
      width: w,
      height: h,
    }),
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    getContextAttributes: () => ({}),
  };

  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol') return undefined;
      const stub = (): undefined => undefined;
      t[prop] = stub;
      return stub;
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    },
  });
}

function fakeElement(tag = 'div'): any {
  const node: any = {
    tagName: tag.toUpperCase(),
    style: {},
    dataset: {},
    children: [] as any[],
    className: '',
    id: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    width: 300,
    height: 150,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop,
    getAttribute: () => null,
    removeAttribute: noop,
    appendChild(child: unknown) {
      node.children.push(child);
      return child;
    },
    replaceChildren(...kids: unknown[]) {
      node.children = kids;
    },
    remove: noop,
    addEventListener: noop,
    removeEventListener: noop,
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
    }),
    focus: noop,
    blur: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    insertBefore: noop,
    cloneNode: () => fakeElement(tag),
    toDataURL: () => 'data:image/png;base64,',
  };
  node.getContext = (kind: string) => (kind === '2d' ? fake2dContext(node) : null);
  return node;
}

/**
 * index.html 里所有会被 pick() 抓的 id。
 *
 * 这份清单是**手抄**的 —— 如果哪天 index.html 加了新 id 而这里忘了加，
 * main.ts 会在这里失败。那正是我们想要的：宁可冒烟测试报错，
 * 也不要浏览器里白屏。
 */
const ELEMENT_IDS = [
  'menu', 'menu-title', 'menu-subtitle', 'level-list', 'menu-save-note', 'menu-reset',
  'battle', 'stage', 'fx-banner', 'hud', 'hud-menu', 'banner', 'turn', 'phase', 'objective',
  'player-count', 'enemy-count', 'unit-info', 'forecast', 'terrain', 'threat-state',
  'sfx-state', 'log', 'result', 'result-title', 'result-detail', 'result-menu', 'result-retry',
] as const;

const registry = new Map<string, any>();
for (const id of ELEMENT_IDS) {
  const element = fakeElement();
  element.id = id;
  registry.set(id, element);
}

const doc: any = {
  readyState: 'complete',
  documentElement: fakeElement('html'),
  head: fakeElement('head'),
  body: fakeElement('body'),
  getElementById: (id: string) => registry.get(id) ?? null,
  createElement: (tag: string) => fakeElement(tag),
  createElementNS: (_ns: string, tag: string) => fakeElement(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: noop,
  removeEventListener: noop,
  createTextNode: (text: string) => ({ textContent: text }),
};

const g = globalThis as any;

/** Node 22 里 navigator / location 是只读 getter，只能 defineProperty */
function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(g, name, { value, writable: true, configurable: true });
}

/* window = globalThis 是把浏览器代码骗过 Node 的最省事做法 */
g.window = g;
g.document = doc;
defineGlobal('navigator', { userAgent: 'node-smoke', maxTouchPoints: 0 });
defineGlobal('location', { href: 'http://localhost/', protocol: 'http:', hostname: 'localhost' });
g.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16);
g.cancelAnimationFrame = noop;
g.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
g.getComputedStyle = () => ({ getPropertyValue: () => '' });
g.devicePixelRatio = 1;
g.screen = { width: 1280, height: 720 };
g.confirm = () => true;
g.alert = noop;
g.HTMLCanvasElement = class {};
g.HTMLImageElement = class {};
g.Image = class {};
g.Audio = class {};

/* ---------------------------------------------------------------- 跑起来 */

try {
  await import('../src/main');
} catch (error) {
  console.error('✗ 浏览器入口在**模块加载期**抛错 —— 真机上会白屏：\n');
  console.error(error);
  process.exit(1);
}

/* 只 import 成功还不够：render 没被调用的话页面照样是空的 */
const { LEVELS } = await import('../src/game/levels');
const textOf = (id: string): string => registry.get(id)?.textContent ?? '';
const kidsOf = (id: string): number => (registry.get(id)?.children.length as number) ?? -1;

const checks: readonly [string, boolean][] = [
  ['菜单标题 = 战役名', textOf('menu-title') === LEVELS.campaign.name],
  ['菜单副标题 = 关卡数', textOf('menu-subtitle') === `共 ${LEVELS.campaign.levels.length} 关`],
  ['关卡列表条数 = 战役关卡数', kidsOf('level-list') === LEVELS.campaign.levels.length],
  ['菜单可见', registry.get('menu')?.hidden === false],
  ['战斗界面隐藏', registry.get('battle')?.hidden === true],
  ['结算面板隐藏', registry.get('result')?.hidden === true],
];

console.log('');
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed += 1;
}
console.log('');

if (failed > 0) {
  console.error(`${failed} 项断言失败 —— 页面起来了，但菜单没渲染对。`);
  process.exit(1);
}

console.log('浏览器入口冒烟测试通过。');
console.log('（这只能证明"跑起来了"，画面和手感仍然要在浏览器里看）');
console.log('');

/* 这一行只是为了把这个文件标成 ES 模块 ——
   否则顶层 await 不合法（TS1375）。它没有任何实际导出。 */
export {};
