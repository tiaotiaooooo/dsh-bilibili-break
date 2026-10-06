/**
 * 文件选择器的单测：worker 用哪个 Node 起、探测的降级路径。
 *
 * `resolveNodeBinary` 是桌面端那个 SIGABRT 崩溃的修复核心——Electron 宿主下必须
 * 用 DSH 自带的独立 Node 而不是 `process.execPath`（Electron 的 N-API 和 koffi
 * 不兼容，worker 走到 `koffi.view()` 就原生崩溃）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveNodeBinary, isFilePickerSupported } from '../lib/picker.js'

/** 按平台拼 node 可执行文件名（和 resolveNodeBinary 内部逻辑一致）。 */
const NODE_NAME = process.platform === 'win32' ? 'node.exe' : 'node'

function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dbb-picker-'))
  const nodePath = join(home, 'dsh-runtimes', 'fake-rt', 'dependencies', 'node', 'bin', NODE_NAME)
  mkdirSync(join(home, 'dsh-runtimes', 'fake-rt', 'dependencies', 'node', 'bin'), { recursive: true })
  writeFileSync(nodePath, '')
  return { home, nodePath }
}

test('picker：非 Electron 宿主直接用 process.execPath（web CLI 路径，已实测）', () => {
  assert.equal(
    resolveNodeBinary({ isElectron: false, execPath: '/x/node', env: {} }),
    '/x/node',
  )
})

test('picker：DSH_PICKER_NODE 覆盖优先（存在才生效）', () => {
  const { home, nodePath } = makeFakeHome()
  try {
    assert.equal(
      resolveNodeBinary({ isElectron: true, execPath: '/x/node', env: { DSH_PICKER_NODE: nodePath } }),
      nodePath,
      '存在的覆盖路径应生效',
    )
    assert.equal(
      resolveNodeBinary({ isElectron: true, execPath: '/electron', env: { DSH_PICKER_NODE: '/no/such/node' }, homes: [home] }),
      nodePath,
      '覆盖路径不存在时忽略之，继续走 dsh-runtimes 搜索',
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('picker：Electron 宿主从 $DSH_HOME/dsh-runtimes 找独立 Node（崩溃修复核心）', () => {
  const { home, nodePath } = makeFakeHome()
  try {
    assert.equal(
      resolveNodeBinary({ isElectron: true, execPath: '/electron', env: {}, homes: [home] }),
      nodePath,
      '应找到 runtimes 里的独立 node',
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('picker：Electron 宿主找不到独立运行时则退回 execPath（宁可 500 不静默）', () => {
  const empty = mkdtempSync(join(tmpdir(), 'dbb-empty-'))
  try {
    assert.equal(
      resolveNodeBinary({ isElectron: true, execPath: '/electron', env: {}, homes: [empty] }),
      '/electron',
    )
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('picker：探测——非 Windows 明确不支持', async () => {
  const result = await isFilePickerSupported(() => false)
  assert.equal(result.ok, false)
  assert.match(result.reason, /Windows/)
})
