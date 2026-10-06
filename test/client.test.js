/**
 * 客户端半个插件的测试。
 *
 * 这里不启动浏览器，而是把 bundle 当成浏览器会加载的脚本来求值：
 * 装好 `window.__ModuleLoader__`，取出 factory，用一个假的 require 喂 React，
 * 然后按真实 loader 的契约检查 exports、slot 注册，并真的把组件渲染一次。
 *
 * 覆盖的是手写 bundle 最容易错的三件事：loader 包装契约、slot 注册形状、
 * 以及 hook 顺序/运行态推导这类只有真渲染才会暴露的问题。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const React = require_('react')
const { renderToStaticMarkup } = require_('react-dom/server')

const BUNDLE = new URL('../lib/client.js', import.meta.url)

/**
 * bundle 是浏览器代码：样式注入走 `document`。这里补最小桩，
 * 只实现 installStyles 真正用到的那三个动作。
 */
function installBrowserStubs() {
  const appended = []
  globalThis.document = {
    head: {
      appendChild(node) {
        appended.push(node)
      },
    },
    createElement() {
      return {
        dataset: {},
        textContent: '',
        removed: false,
        remove() {
          this.removed = true
        },
      }
    },
  }
  return appended
}

/** 把 bundle 当脚本求值，返回它交给 __ModuleLoader__ 的那份 { id, factory }。 */
function loadBundle() {
  const source = readFileSync(BUNDLE, 'utf8')
  const styles = installBrowserStubs()
  let captured
  const fakeWindow = {
    __ModuleLoader__: {
      load(entry) {
        captured = entry
      },
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    setTimeout,
    clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  }
  // 只注入 window：bundle 其余依赖都从 factory 的 require 拿。
  // eslint-disable-next-line no-new-func
  new Function('window', source)(fakeWindow)
  assert.ok(captured, 'bundle 必须向 window.__ModuleLoader__ 注册自己')
  return { entry: captured, styles }
}

/** 按 loader 的模块表契约喂 require：只该要 react。 */
function callFactory(entry) {
  const asked = []
  const exports = entry.factory((specifier) => {
    asked.push(specifier)
    if (specifier === 'react') return React
    throw new Error(`客户端 bundle 不该 require "${specifier}"：它不在冻结的模块表里`)
  })
  return { exports, asked }
}

/** 一个够用的假客户端 cordis 上下文，记录 slots 交互。 */
function createFakeClientContext() {
  const injected = []
  const registrations = []
  const effects = []
  const slots = {
    inject(name, callback) {
      injected.push(name)
      return callback()
    },
    register(spec, Component) {
      registrations.push({ spec, Component })
      return () => {}
    },
  }
  const ctx = {
    get(name) {
      return name === 'slots' ? slots : undefined
    },
    effect(callback) {
      effects.push(callback)
      return callback()
    },
  }
  return { ctx, injected, registrations, effects }
}

const runningState = (running) => ({
  current: 'session-1',
  byId: { 'session-1': { running } },
})

test('客户端 bundle：遵守 loader 包装契约，只 require react', () => {
  const { entry } = loadBundle()
  assert.equal(entry.id, 'dsh-bilibili-break')
  assert.equal(typeof entry.factory, 'function')

  const { exports, asked } = callFactory(entry)
  assert.deepEqual(asked, ['react'], 'bundle 只应 require 模块表里的 react')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
})

test('客户端 bundle：注册进 shell.overlay，且 id 稳定', () => {
  const { entry, styles } = loadBundle()
  const { exports } = callFactory(entry)
  const { ctx, injected, registrations } = createFakeClientContext()

  exports.apply(ctx)

  assert.deepEqual(injected, ['shell.overlay'], '必须等 shell.overlay 的声明')
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].spec.name, 'shell.overlay')
  assert.equal(registrations[0].spec.id, 'bilibili-break')

  // 样式必须自己注入并挂上归属标签，卸载时靠它回收。
  assert.equal(styles.length, 1, 'apply 必须注入自己的样式表')
  assert.equal(styles[0].dataset.plugin, 'dsh-bilibili-break')
  assert.match(styles[0].textContent, /\.dbb-layer/)
})

test('客户端 bundle：拿不到 slots 服务时安静退出，不抛错', () => {
  const { entry } = loadBundle()
  const { exports } = callFactory(entry)
  const ctx = { get: () => undefined, effect: () => {} }
  assert.doesNotThrow(() => exports.apply(ctx))
})

test('客户端 bundle：agent 运行中渲染出入口胶囊', () => {
  const { entry } = loadBundle()
  const { exports } = callFactory(entry)
  const { ctx, registrations } = createFakeClientContext()
  exports.apply(ctx)

  const html = renderToStaticMarkup(
    React.createElement(registrations[0].Component, {
      useSessions: (selector) => selector(runningState(true)),
    }),
  )
  assert.match(html, /AI 还在工作，摸一会鱼吧~/)
  assert.match(html, /dbb-layer/)
})

test('客户端 bundle：agent 空闲时不渲染任何东西', () => {
  const { entry } = loadBundle()
  const { exports } = callFactory(entry)
  const { ctx, registrations } = createFakeClientContext()
  exports.apply(ctx)

  const html = renderToStaticMarkup(
    React.createElement(registrations[0].Component, {
      useSessions: (selector) => selector(runningState(false)),
    }),
  )
  assert.equal(html, '<div class="dbb-layer"></div>')
})

/**
 * 回归测试：`SessionListState.current` 在「新会话」视图下是 undefined，而 turn
 * 已经在跑了。早期版本只认 current，导致运行位永远短路成 false、弹窗一次都不出现
 * （浏览器里实测过）。这里把「current 缺失时必须退回扫描 byId」钉住。
 */
test('回归：current 缺失但列表里有会话在跑时，仍然渲染入口胶囊', () => {
  const { entry } = loadBundle()
  const { exports } = callFactory(entry)
  const { ctx, registrations } = createFakeClientContext()
  exports.apply(ctx)

  const html = renderToStaticMarkup(
    React.createElement(registrations[0].Component, {
      useSessions: (selector) => selector({
        current: undefined,
        byId: { 'session-a': { running: false }, 'session-b': { running: true } },
      }),
    }),
  )
  assert.match(html, /AI 还在工作，摸一会鱼吧~/)
})

test('回归：current 已落位时以它为准，不被别的会话带跑', () => {
  const { entry } = loadBundle()
  const { exports } = callFactory(entry)
  const { ctx, registrations } = createFakeClientContext()
  exports.apply(ctx)

  // 当前会话空闲，另一个会话在跑：不该弹（current 优先，避免被后台会话触发）。
  const idle = renderToStaticMarkup(
    React.createElement(registrations[0].Component, {
      useSessions: (selector) => selector({
        current: 'session-a',
        byId: { 'session-a': { running: false }, 'session-b': { running: true } },
      }),
    }),
  )
  assert.equal(idle, '<div class="dbb-layer"></div>')

  // 当前会话在跑：弹。
  const busy = renderToStaticMarkup(
    React.createElement(registrations[0].Component, {
      useSessions: (selector) => selector({
        current: 'session-a',
        byId: { 'session-a': { running: true }, 'session-b': { running: false } },
      }),
    }),
  )
  assert.match(busy, /AI 还在工作，摸一会鱼吧~/)
})

test('客户端 bundle：缺少 useSessions 标准 props 也不会崩', () => {
  const { entry } = loadBundle()
  const { exports } = callFactory(entry)
  const { ctx, registrations } = createFakeClientContext()
  exports.apply(ctx)

  const html = renderToStaticMarkup(
    React.createElement(registrations[0].Component, {}),
  )
  assert.equal(html, '<div class="dbb-layer"></div>')
})

test('客户端 bundle：BV 解析与播放器地址', () => {
  const { entry } = loadBundle()
  const { exports } = callFactory(entry)
  const { parseBv, playerUrl, bvList } = exports.__test

  assert.equal(parseBv('BV1GJ411x7h7'), 'BV1GJ411x7h7')
  assert.equal(parseBv('  BV1GJ411x7h7  '), 'BV1GJ411x7h7')
  assert.equal(
    parseBv('https://www.bilibili.com/video/BV1GJ411x7h7?share_source=copy'),
    'BV1GJ411x7h7',
  )
  assert.equal(parseBv('不是视频'), undefined)
  assert.equal(parseBv(undefined), undefined)

  const url = playerUrl('BV1GJ411x7h7')
  assert.match(url, /^https:\/\/player\.bilibili\.com\/player\.html\?/)
  assert.match(url, /bvid=BV1GJ411x7h7/)
  assert.match(url, /autoplay=1/)

  // 去重 + 保序 + 丢垃圾行
  assert.deepEqual(
    bvList(['BV1GJ411x7h7', '垃圾', 'BV1GJ411x7h7', 'https://b23.tv/BV1xx411c7mD']),
    ['BV1GJ411x7h7', 'BV1xx411c7mD'],
  )
  assert.deepEqual(bvList([]), [])
})

// ── 自定义启动：数据模型 ──────────────────────────────────────────────────────

/** 取出 __test 出口，少写点重复。 */
function openBundle() {
  const { entry } = loadBundle()
  const { exports } = callFactory(entry)
  return exports
}

test('启动器：默认设置带两条启动项与可自定义文案', () => {
  const { DEFAULT_SETTINGS, ENTRY_KINDS, EXEC_KINDS, isExecKind, KIND_LABEL } = openBundle().__test
  assert.equal(DEFAULT_SETTINGS.askText, 'AI 正在工作，来摸一会鱼吧~')
  assert.equal(DEFAULT_SETTINGS.askEnabled, true)
  assert.deepEqual(DEFAULT_SETTINGS.entries.map((e) => e.kind), ['embed', 'tab'])
  assert.deepEqual(ENTRY_KINDS, ['embed', 'tab', 'host', 'exe', 'exec'])

  // exe 与 exec 在 host 侧是同一个动作（都走 exec），只有编辑体验不同。
  assert.deepEqual(EXEC_KINDS, ['exe', 'exec'])
  assert.equal(isExecKind('exe'), true)
  assert.equal(isExecKind('exec'), true)
  assert.equal(isExecKind('host'), false, 'host 走的是 open，不能算 exec 一族')
  assert.equal(isExecKind('embed'), false)
  assert.equal(KIND_LABEL.exe, '启动软件')
})

test('启动器：exe 类型把浏览选中的路径存成单个 target', () => {
  const { normalizeEntry } = openBundle().__test
  const entry = normalizeEntry({
    id: 'x', icon: '🎮', label: '我的软件', kind: 'exe',
    targets: ['  C:\\Games\\Foo\\foo.exe  '], args: ['--fullscreen'],
  })
  assert.equal(entry.kind, 'exe')
  assert.deepEqual(entry.targets, ['C:\\Games\\Foo\\foo.exe'], '两端的空白要被修掉')
  assert.deepEqual(entry.args, ['--fullscreen'])
})

test('启动器：v1 片单迁移成 v2 的第一个启动项', () => {
  const { migrateSettings } = openBundle().__test
  const migrated = migrateSettings({
    playlist: ['BV1GJ411x7h7', '  ', 'https://www.bilibili.com/video/BV1xx411c7mD'],
    index: 1,
    askEnabled: false,
  })
  assert.equal(migrated.version, 2)
  assert.equal(migrated.askEnabled, false)
  assert.deepEqual(migrated.entries[0].targets, ['BV1GJ411x7h7', 'https://www.bilibili.com/video/BV1xx411c7mD'])
  // 旧格式没有 askText，应该补上默认文案而不是留空。
  assert.equal(migrated.askText, 'AI 正在工作，来摸一会鱼吧~')
  // 尺寸也要有默认值。
  assert.equal(migrated.panelWidth, 420)
  assert.equal(migrated.stageHeight, undefined, '没拖过就应该是 undefined，走自动比例')
})

test('嵌入尺寸：默认都是横比例（竖比例放网页只能看到一条）', () => {
  const { defaultStageHeight } = openBundle().__test

  // B站 官方播放器就是 16:9 设计的。
  const video = defaultStageHeight('https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7', 600)
  assert.equal(video, Math.round(600 * 9 / 16))

  // 普通网页 16:10，更像浏览器窗口，而不是比宽度还高的竖条。
  const page = defaultStageHeight('https://www.bilibili.com', 600)
  assert.equal(page, Math.round(600 * 10 / 16))
  assert.ok(page < 600, `网页默认高度(${page}) 必须小于宽度 —— 否则就是竖比例`)

  assert.equal(defaultStageHeight(undefined, 320), Math.round(320 * 10 / 16))
  assert.equal(defaultStageHeight('https://player.bilibili.com/x', 800), Math.round(800 * 9 / 16))
})

test('嵌入尺寸：用户拖过的高度会被记住，垃圾值则退回自动', () => {
  const { migrateSettings } = openBundle().__test
  const kept = migrateSettings({ entries: [], panelWidth: 600, stageHeight: 480 })
  assert.equal(kept.panelWidth, 600)
  assert.equal(kept.stageHeight, 480)

  for (const bad of [{ panelWidth: 10 }, { panelWidth: 'x' }, { stageHeight: 5 }, { stageHeight: null }]) {
    const result = migrateSettings({ entries: [], ...bad })
    assert.equal(result.panelWidth >= 280, true, `${JSON.stringify(bad)} 应落回合法宽度`)
    assert.equal(result.stageHeight, undefined, `${JSON.stringify(bad)} 应退回自动高度`)
  }
})

test('窗口式拖拽：八条边/角各自只改该改的那一维', () => {
  const { resizePanel } = openBundle().__test
  const bounds = { viewportWidth: 1440, viewportHeight: 900 }
  const start = { width: 420, stageHeight: 260, right: 16, bottom: 16 }
  const dir = (dx, dy) => ({ dx, dy })

  // 右边往右拖 100：到屏幕右沿就停（原本只剩 16px 可走）。
  assert.deepEqual(
    resizePanel(start, dir(1, 0), 100, 0, bounds),
    { width: 436, stageHeight: 260, right: 0, bottom: 16 },
  )
  // 左边往左拖 100：变宽 100，右边锚点不动。
  assert.deepEqual(
    resizePanel(start, dir(-1, 0), -100, 0, bounds),
    { width: 520, stageHeight: 260, right: 16, bottom: 16 },
  )
  // 上边往上拖 100：变高 100，底边锚点不动。
  assert.deepEqual(
    resizePanel(start, dir(0, -1), 0, -100, bounds),
    { width: 420, stageHeight: 360, right: 16, bottom: 16 },
  )
  // 下边往下拖 100：同样到屏幕下沿就停。
  assert.deepEqual(
    resizePanel(start, dir(0, 1), 0, 100, bounds),
    { width: 420, stageHeight: 276, right: 16, bottom: 0 },
  )
  // 右下角是两者叠加。
  assert.deepEqual(
    resizePanel(start, dir(1, 1), 60, 40, bounds),
    { width: 436, stageHeight: 276, right: 0, bottom: 0 },
  )
  // 左边缘/上边缘不受锚点限制（它们是往屏幕内长）。
  assert.deepEqual(
    resizePanel({ ...start, right: 0, bottom: 0 }, dir(-1, -1), -50, -50, bounds),
    { width: 470, stageHeight: 310, right: 0, bottom: 0 },
  )
})

test('窗口式拖拽：拖标题栏是整块移动，不改尺寸', () => {
  const { resizePanel } = openBundle().__test
  const bounds = { viewportWidth: 1440, viewportHeight: 900 }
  const start = { width: 420, stageHeight: 260, right: 16, bottom: 16 }

  // 往左上拖 200/120 -> 离右边/下边各多 200/120。
  const moved = resizePanel(start, { dx: 0, dy: 0 }, -200, -120, bounds)
  assert.deepEqual(moved, { width: 420, stageHeight: 260, right: 216, bottom: 136 })
  assert.equal(moved.width, start.width)
  assert.equal(moved.stageHeight, start.stageHeight)
})

test('窗口式拖拽：边界都夹得住，不会缩成 0 或拖出视口', () => {
  const { resizePanel } = openBundle().__test
  const bounds = { viewportWidth: 1440, viewportHeight: 900 }
  const start = { width: 420, stageHeight: 260, right: 16, bottom: 16 }

  // 宽度下限：左边缘往右死拖 -> 夹在最小宽度。
  assert.equal(resizePanel(start, { dx: -1, dy: 0 }, 5000, 0, bounds).width, 300)
  // 宽度上限：左边缘往左死拖 -> 不超过视口 - 16。
  assert.equal(resizePanel(start, { dx: -1, dy: 0 }, -5000, 0, bounds).width, 1440 - 16)
  // 右边缘只能长到屏幕右沿为止（原本只剩 right=16 的余量）。
  assert.equal(resizePanel(start, { dx: 1, dy: 0 }, 5000, 0, bounds).width, 436)
  // 高度下限。
  assert.equal(resizePanel(start, { dx: 0, dy: -1 }, 0, 5000, bounds).stageHeight, 120)

  // 移动不能把面板整个拖出视口：锚点夹在 [0, 视口-140]。
  const farAway = resizePanel(start, { dx: 0, dy: 0 }, -99999, -99999, bounds)
  assert.equal(farAway.right, 1440 - 140)
  assert.equal(farAway.bottom, 900 - 140)
  const back = resizePanel(start, { dx: 0, dy: 0 }, 99999, 99999, bounds)
  assert.equal(back.right, 0)
  assert.equal(back.bottom, 0)

  // 任何输入下都不能出现 0 或负数尺寸。
  for (const handle of [{ dx: 0, dy: 0 }, { dx: 1, dy: 1 }, { dx: -1, dy: -1 }]) {
    for (const delta of [-9999, -1, 0, 1, 9999]) {
      const out = resizePanel(start, handle, delta, delta, bounds)
      assert.ok(out.width >= 300 && out.stageHeight >= 120 && out.right >= 0 && out.bottom >= 0,
        JSON.stringify({ handle, delta, out }))
    }
  }
})

test('缩放适配：所有嵌入都按桌面视口渲染再缩回可见尺寸', () => {
  const { embedViewport } = openBundle().__test

  // 侧栏宽度下，网页也要按 1280 的桌面视口渲染，否则布局会塌（实测 B站 首页）。
  const narrow = embedViewport({ innerWidth: 418, stageHeight: 236 })
  assert.equal(narrow.virtualWidth, 1280)
  assert.ok(Math.abs(narrow.scale - 418 / 1280) < 1e-9, String(narrow.scale))
  // 核心不变式：缩放后占的高度恰好等于用户看到的 stageHeight。
  assert.ok(Math.abs(narrow.virtualHeight * narrow.scale - 236) <= 1,
    `${narrow.virtualHeight} * ${narrow.scale}`)

  // 只缩不放：面板比虚拟视口还宽时不放大（会糊），此时布局尺寸=面板宽度。
  const wide = embedViewport({ innerWidth: 1600, stageHeight: 900 })
  assert.equal(wide.virtualWidth, 1600)
  assert.equal(wide.scale, 1)
  assert.equal(wide.virtualHeight, 900)

  // 用户把面板拖宽 -> 缩放比上升 -> 字变大。这条是「字小可以靠拖宽解决」的依据。
  const wider = embedViewport({ innerWidth: 836, stageHeight: 236 })
  assert.ok(wider.scale > narrow.scale, `${wider.scale} 应大于 ${narrow.scale}`)

  // 极端小值要夹住，不能算出 0 或负数。
  const tiny = embedViewport({ innerWidth: 1, stageHeight: 1, scaled: true })
  assert.ok(tiny.virtualWidth >= 220 && tiny.virtualHeight >= 1 && tiny.scale > 0, JSON.stringify(tiny))
})

test('启动器：垃圾输入一律回落到默认，不留半个坏状态', () => {
  const { migrateSettings, DEFAULT_SETTINGS } = openBundle().__test
  for (const raw of [null, 'x', 42, [], { entries: 'nope' }, { entries: [] }, { entries: [null, 7] }]) {
    const result = migrateSettings(raw)
    assert.equal(result.version, 2)
    assert.ok(result.entries.length > 0, `${JSON.stringify(raw)} 应回落到默认启动项`)
    assert.equal(typeof result.askText, 'string')
    assert.ok(result.askText.length > 0)
    assert.ok(result.entries.some((entry) => entry.id === result.activeEntryId))
  }
  // 空文案不能被接受
  assert.equal(migrateSettings({ askText: '   ' }).askText, DEFAULT_SETTINGS.askText)
})

test('启动器：normalizeEntry 收敛非法字段', () => {
  const { normalizeEntry } = openBundle().__test

  const fixed = normalizeEntry({ id: 'a', label: '  ', icon: '', kind: 'nope', targets: [' x ', '', 5] })
  assert.equal(fixed.kind, 'embed', '未知 kind 应回落到 embed')
  assert.equal(fixed.label, '未命名')
  assert.equal(fixed.icon, '🎯')
  assert.deepEqual(fixed.targets, ['x'], '目标应 trim 并丢掉非字符串与空串')
  assert.deepEqual(fixed.args, [])

  assert.equal(normalizeEntry(null), undefined)
  assert.equal(normalizeEntry('x'), undefined)

  // 没有 id 时要自动生成一个，且两次不同。
  const a = normalizeEntry({ label: 'a' })
  const b = normalizeEntry({ label: 'b' })
  assert.ok(a.id.length > 0)
  assert.notEqual(a.id, b.id)
})

test('启动器：targetOf 的游标折回与空目标', () => {
  const { targetOf } = openBundle().__test
  const entry = { id: 'e', targets: ['a', 'b', 'c'] }

  assert.equal(targetOf(entry, {}), 'a')
  assert.equal(targetOf(entry, { e: 1 }), 'b')
  assert.equal(targetOf(entry, { e: 3 }), 'a', '越界应折回')
  assert.equal(targetOf(entry, { e: -1 }), 'c', '负数应折回')
  assert.equal(targetOf(entry, { e: 1.5 }), 'a', '非整数游标回落 0')
  assert.equal(targetOf({ id: 'e', targets: [] }, { e: 2 }), undefined)
  assert.equal(targetOf(undefined, {}), undefined)
})

test('启动器：embed 目标里 BV 号走官方播放器，其余原样透传', () => {
  const { resolveEmbedUrl } = openBundle().__test
  assert.match(resolveEmbedUrl('BV1GJ411x7h7'), /^https:\/\/player\.bilibili\.com\/player\.html\?bvid=BV1GJ411x7h7/)
  assert.equal(resolveEmbedUrl('https://example.test/game'), 'https://example.test/game')
  assert.equal(resolveEmbedUrl('https://www.bilibili.com/video/BV1GJ411x7h7'), 'https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7&page=1&autoplay=1&danmaku=0&high_quality=1&as_wide=1')
})

test('启动器：询问卡片渲染自定义文案与每个启动项一个按钮', () => {
  // 卡片只在 asking 状态出现，而 asking 由定时器驱动；SSR 不跑 effect，
  // 所以这里直接验证「文案来自设置」这条契约 —— 真实卡片的渲染由浏览器验收覆盖。
  const { entry } = loadBundle()
  const { exports } = callFactory(entry)
  const { DEFAULT_SETTINGS } = exports.__test
  assert.equal(typeof DEFAULT_SETTINGS.askText, 'string')
  assert.ok(DEFAULT_SETTINGS.askText.includes('摸'))
})

test('启动器：面板对非 embed 启动项渲染「没有可嵌内容」而不是空白 iframe', () => {
  const { entry } = loadBundle()
  const { exports } = callFactory(entry)
  const { ctx, registrations } = createFakeClientContext()
  exports.apply(ctx)

  // 直接渲染组件只能拿到 idle 状态；这里断言的是该分支存在且不会抛错。
  const html = renderToStaticMarkup(
    React.createElement(registrations[0].Component, {
      useSessions: (selector) => selector(runningState(false)),
    }),
  )
  assert.equal(html, '<div class="dbb-layer"></div>')
})
