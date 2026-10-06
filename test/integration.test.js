/**
 * 集成测试：在一个真实的 cordis 根上装载插件，验证单测里被假上下文掩盖的三件事——
 *   1. `inject: ['timer']` 真的会等 timer 服务，而不是空转；
 *   2. 导出的 `Config` schema 真的在装载路径上生效；
 *   3. `ctx.timeout` 真的来自 timer 服务的 mixin，并且事件真的派发到监听器。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'

import * as plugin from '../index.js'

const DRY_RUN = {
  openInBrowser: false,
  delaySeconds: 0,
  cooldownSeconds: 0,
  maxOpensPerSession: 0,
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 在根上下文上挂一个采集器，把结构化日志记录收进数组。 */
function createRoot() {
  const root = new Context()
  const records = []
  root.logger.exporter({ export: (message) => records.push(message) })
  const text = () => records.map((record) => record.args.join(' ')).join('\n')
  return { root, records, text }
}

test('集成：装载 timer 后插件生效，turn/start 触发一次干跑', async () => {
  const { root, text } = createRoot()
  await root.plugin(TimerService)
  await root.plugin(plugin, DRY_RUN)

  root.emit('session/event', { id: 's-1' }, { type: 'turn/start', turn: 1 })
  await sleep(60)

  assert.match(text(), /已挂载/)
  assert.match(text(), /\[干跑\]/)
  assert.match(text(), /bilibili\.com/)

  await root.fiber.dispose()
})

test('集成：inject 门控 —— 没有 timer 服务时插件不 apply', async () => {
  const { root, text } = createRoot()
  // 刻意不装载 TimerService。
  await root.plugin(plugin, DRY_RUN)

  root.emit('session/event', { id: 's-1' }, { type: 'turn/start', turn: 1 })
  await sleep(60)

  // 装配日志是 apply 里第一件事，它没出现就说明插件仍停在等待态。
  assert.doesNotMatch(text(), /已挂载/)

  await root.plugin(TimerService)
  await sleep(20)
  assert.match(text(), /已挂载/)

  await root.fiber.dispose()
})

test('集成：Config schema 在装载路径上校验并补默认值', async () => {
  const { root, text } = createRoot()
  await root.plugin(TimerService)

  // 缺字段应由 schema 补上默认值（delaySeconds 默认 10s，所以快速轮次不会触发）。
  await root.plugin(plugin, {})
  root.emit('session/event', { id: 's-default' }, { type: 'turn/start', turn: 1 })
  await sleep(40)
  assert.doesNotMatch(text(), /\[干跑\]/)

  // 越界值应被 schema 拒绝，而不是悄悄跑起来。
  await assert.rejects(async () => {
    await root.plugin(plugin, { delaySeconds: -1 })
  })

  await root.fiber.dispose()
})

test('集成：turn/end 撤销待触发的定时器', async () => {
  const { root, text } = createRoot()
  await root.plugin(TimerService)
  await root.plugin(plugin, DRY_RUN)

  const session = { id: 's-cancel' }
  root.emit('session/event', session, { type: 'turn/start', turn: 1 })
  root.emit('session/event', session, { type: 'turn/end', turn: 1, reason: 'completed' })
  await sleep(120)

  assert.doesNotMatch(text(), /\[干跑\]/)

  await root.fiber.dispose()
})

test('集成：重复 turn/start 只留一个定时器，不会重复打开', async () => {
  const { root, text } = createRoot()
  await root.plugin(TimerService)
  await root.plugin(plugin, DRY_RUN)

  const session = { id: 's-dup' }
  root.emit('session/event', session, { type: 'turn/start', turn: 1 })
  root.emit('session/event', session, { type: 'turn/start', turn: 1 })
  await sleep(120)

  const dryRuns = text().split('\n').filter((line) => line.includes('[干跑]'))
  assert.equal(dryRuns.length, 1)

  await root.fiber.dispose()
})
