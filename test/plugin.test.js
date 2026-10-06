/**
 * 纯逻辑与调度行为的单测。全程不真的弹浏览器：
 * apply() 一律传 openInBrowser: false，开不开只看日志里的「干跑」记录。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CONFIG,
  browserCommand,
  decideOpen,
  normalizeConfig,
  apply,
} from '../index.js'

/** 一个刚好够 apply() 用的假 cordis 上下文。 */
function createFakeContext({ webServer } = {}) {
  const listeners = new Map()
  const logs = []
  const pendingTimers = new Set()
  const routes = []

  const record = (level) => (...args) => logs.push({ level, args: args.map(String) })

  return {
    logs,
    routes,
    logger: { info: record('info'), warn: record('warn') },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    /**
     * 默认假装没有 webServer —— 真实环境里 headless profile 就是这样，
     * 路由那条 cordis 依赖永远不满足，插件其余部分必须照常工作。
     */
    inject(deps, callback) {
      if (webServer === undefined) return undefined
      if (!deps.includes('webServer')) return undefined
      callback({ webServer, effect: (fn) => fn() })
      return undefined
    },
    timeout(callback, delay) {
      const entry = {}
      entry.timer = setTimeout(() => {
        pendingTimers.delete(entry)
        callback()
      }, delay)
      pendingTimers.add(entry)
      return () => {
        if (!pendingTimers.delete(entry)) return
        clearTimeout(entry.timer)
      }
    },
    effect() {},
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    /** 定时器全部触发或撤销后 resolve。 */
    settle(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    },
  }
}

const dryRun = { openInBrowser: false }
const sessionOf = (id) => ({ id })

// --- normalizeConfig ---------------------------------------------------------

test('normalizeConfig: 空输入回落到默认值', () => {
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG)
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG)
  assert.deepEqual(normalizeConfig('nonsense'), DEFAULT_CONFIG)
  assert.deepEqual(normalizeConfig(42), DEFAULT_CONFIG)
})

test('normalizeConfig: 空 url 与负数值不会穿透', () => {
  const config = normalizeConfig({
    url: '   ',
    delaySeconds: -5,
    cooldownSeconds: Number.NaN,
    maxOpensPerSession: Number.POSITIVE_INFINITY,
  })
  assert.equal(config.url, DEFAULT_CONFIG.url)
  assert.equal(config.delaySeconds, DEFAULT_CONFIG.delaySeconds)
  assert.equal(config.cooldownSeconds, DEFAULT_CONFIG.cooldownSeconds)
  assert.equal(config.maxOpensPerSession, DEFAULT_CONFIG.maxOpensPerSession)
})

test('normalizeConfig: 显式 false 会生效，而不是被默认值吃掉', () => {
  const config = normalizeConfig({
    enabled: false,
    openInBrowser: false,
    cooldownSeconds: 0,
    maxOpensPerSession: 0,
  })
  assert.equal(config.enabled, false)
  assert.equal(config.openInBrowser, false)
  assert.equal(config.cooldownSeconds, 0)
  assert.equal(config.maxOpensPerSession, 0)
})

// --- decideOpen --------------------------------------------------------------

const base = normalizeConfig({ cooldownSeconds: 600, maxOpensPerSession: 3 })

test('decideOpen: 首次满足条件时打开', () => {
  const verdict = decideOpen({
    config: base,
    now: 1_000_000,
    lastOpenedAt: 0,
    opensThisSession: 0,
  })
  assert.equal(verdict.open, true)
})

test('decideOpen: 禁用时不开', () => {
  const verdict = decideOpen({
    config: normalizeConfig({ enabled: false }),
    now: 1_000_000,
    lastOpenedAt: 0,
    opensThisSession: 0,
  })
  assert.equal(verdict.open, false)
  assert.match(verdict.reason, /禁用/)
})

test('decideOpen: 冷却期内不开，冷却过后再开', () => {
  const args = { config: base, lastOpenedAt: 1_000_000, opensThisSession: 1 }
  assert.equal(decideOpen({ ...args, now: 1_000_000 + 599_000 }).open, false)
  assert.match(decideOpen({ ...args, now: 1_000_000 + 599_000 }).reason, /冷却/)
  assert.equal(decideOpen({ ...args, now: 1_000_000 + 600_000 }).open, true)
})

test('decideOpen: 达到单会话上限后不开；0 表示不限', () => {
  const capped = { config: base, now: 9_999_999_999, lastOpenedAt: 0, opensThisSession: 3 }
  assert.equal(decideOpen(capped).open, false)
  assert.match(decideOpen(capped).reason, /单会话上限/)

  const unlimited = {
    config: normalizeConfig({ maxOpensPerSession: 0 }),
    now: 9_999_999_999,
    lastOpenedAt: 0,
    opensThisSession: 99,
  }
  assert.equal(decideOpen(unlimited).open, true)
})

// --- browserCommand ----------------------------------------------------------

test('browserCommand: 各平台用系统默认处理程序，且不经过 shell', () => {
  const win = browserCommand('https://www.bilibili.com/video/BV1xx?a=1&b=2', 'win32')
  assert.equal(win.command, 'rundll32.exe')
  // URL 必须是完整的单个参数：查询串里的 & 不能被二次解析。
  assert.deepEqual(win.args, ['url.dll,FileProtocolHandler', 'https://www.bilibili.com/video/BV1xx?a=1&b=2'])

  assert.deepEqual(browserCommand('https://x.test', 'darwin'), {
    command: 'open',
    args: ['https://x.test'],
  })
  assert.deepEqual(browserCommand('https://x.test', 'linux'), {
    command: 'xdg-open',
    args: ['https://x.test'],
  })
})

// --- apply: 调度行为 ---------------------------------------------------------

test('apply: 一轮在延迟内就结束则什么都不做', async () => {
  const ctx = createFakeContext()
  apply(ctx, { ...dryRun, delaySeconds: 0.05 })

  const session = sessionOf('s-quick')
  ctx.emit('session/event', session, { type: 'turn/start', turn: 1 })
  ctx.emit('session/event', session, { type: 'turn/end', turn: 1, reason: 'completed' })

  await ctx.settle(120)
  assert.equal(ctx.logs.some((line) => line.args.join(' ').includes('[干跑]')), false)
})

test('apply: 一轮忙过延迟后触发一次打开', async () => {
  const ctx = createFakeContext()
  apply(ctx, { ...dryRun, delaySeconds: 0.05 })

  const session = sessionOf('s-slow')
  ctx.emit('session/event', session, { type: 'turn/start', turn: 1 })

  await ctx.settle(120)
  const dryRuns = ctx.logs.filter((line) => line.args.join(' ').includes('[干跑]'))
  assert.equal(dryRuns.length, 1)
  assert.match(dryRuns[0].args.join(' '), /bilibili\.com/)
})

test('apply: 全局冷却把第二个会话挡在外面', async () => {
  const ctx = createFakeContext()
  apply(ctx, { ...dryRun, delaySeconds: 0.02, cooldownSeconds: 600 })

  ctx.emit('session/event', sessionOf('s-1'), { type: 'turn/start', turn: 1 })
  await ctx.settle(40)
  ctx.emit('session/event', sessionOf('s-2'), { type: 'turn/start', turn: 1 })
  await ctx.settle(40)

  assert.equal(ctx.logs.filter((line) => line.args.join(' ').includes('[干跑]')).length, 1)
  assert.ok(ctx.logs.some((line) => line.args.join(' ').includes('冷却')))
})

test('apply: 单会话上限生效，另一个会话仍可打开', async () => {
  const ctx = createFakeContext()
  apply(ctx, { ...dryRun, delaySeconds: 0.02, cooldownSeconds: 0, maxOpensPerSession: 1 })

  ctx.emit('session/event', sessionOf('s-a'), { type: 'turn/start', turn: 1 })
  await ctx.settle(40)
  ctx.emit('session/event', sessionOf('s-a'), { type: 'turn/start', turn: 2 })
  await ctx.settle(40)
  ctx.emit('session/event', sessionOf('s-b'), { type: 'turn/start', turn: 1 })
  await ctx.settle(40)

  const dryRuns = ctx.logs.filter((line) => line.args.join(' ').includes('[干跑]'))
  assert.equal(dryRuns.length, 2)
  assert.ok(ctx.logs.some((line) => line.args.join(' ').includes('单会话上限')))
})

test('apply: 与 turn 无关的事件被忽略', async () => {
  const ctx = createFakeContext()
  apply(ctx, { ...dryRun, delaySeconds: 0.02 })

  const session = sessionOf('s-noise')
  ctx.emit('session/event', session, { type: 'assistant/chunk', turn: 1, step: 1 })
  ctx.emit('session/event', session, { type: 'step/start', turn: 1, step: 1 })
  await ctx.settle(60)

  assert.equal(ctx.logs.filter((line) => line.args.join(' ').includes('[干跑]')).length, 0)
})

test('apply: 没有 id 的会话不会崩', async () => {
  const ctx = createFakeContext()
  apply(ctx, { ...dryRun, delaySeconds: 0.02 })

  ctx.emit('session/event', undefined, { type: 'turn/start', turn: 1 })
  await ctx.settle(60)

  assert.equal(ctx.logs.filter((line) => line.args.join(' ').includes('[干跑]')).length, 1)
})

test('apply: 没有 webServer 时安静跳过路由注册（headless 部署）', () => {
  const ctx = createFakeContext()
  assert.doesNotThrow(() => apply(ctx, dryRun))
  assert.deepEqual(ctx.routes, [])
})

test('apply: 有 webServer 时注册 hello / pick-file / launch 三条路由', async () => {
  const ctx = createFakeContext({
    webServer: {
      register(spec) {
        ctx.routes.push(spec)
        return () => {}
      },
    },
  })
  // apply 是 async 的（pick-file 那条路由要先探一次原生选择框）。
  await apply(ctx, dryRun)

  assert.deepEqual(
    ctx.routes.map((route) => [route.kind, route.path]).sort((a, b) => (a[1] < b[1] ? -1 : 1)),
    [
      ['exact', '/_dsh/bilibili-break/hello'],
      ['exact', '/_dsh/bilibili-break/pick-file'],
      ['exact', '/_dsh/bilibili-break/launch'],
    ].sort((a, b) => (a[1] < b[1] ? -1 : 1)),
  )
  for (const route of ctx.routes) assert.equal(typeof route.handler, 'function')
})
