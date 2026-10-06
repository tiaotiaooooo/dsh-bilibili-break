/**
 * 原生「选择文件」对话框（Windows）。
 *
 * DSH 自带的 `ctx.directoryPicker` 只选**目录**（它的 Win32 worker 用的是
 * `IFileOpenDialog` + `FOS_PICKFOLDERS`），拿不到单个文件。这里自己起一个同样的
 * COM 对话，只把 options 换成「必须是已存在的文件」。
 *
 * 为什么在子进程里弹：
 *
 * - `IFileDialog::Show` 是**阻塞**的模态循环，放在 host 主线程会把整个 DSH 卡住；
 * - 子进程的对话框是它自己的第一个窗口，Windows 会自动把它带到前台，不需要
 *   `SetForegroundWindow` 那套把戏。
 *
 * 结果走 IPC 回传，协议和 DSH 那个 worker 一致：先 `{kind:'showing',threadId}`，
 * 再恰好一条 `{kind:'done',path}` 或 `{kind:'error',message}`。`path` 为 null 表示
 * 用户取消了。
 *
 * 依赖 `koffi`（原生 FFI）。它在 DSH 的 profile 里是现成的（`dsh-native-command`
 * 的依赖），但不在本插件的 dependencies 里 —— 所以整条链路都必须在加载失败时优雅
 * 退化：`isFilePickerSupported` 先探一次，失败就让界面退回手填路径。
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `IFileOpenDialog::SetOptions` 的位。
 *
 * `FOS_FORCEFILESYSTEM` 保证返回的是真实文件系统路径（而不是虚拟 shell 项），
 * `FOS_PATHMUSTEXIST` / `FOS_FILEMUSTEXIST` 保证选到的是已存在的文件。
 *
 * 对照：DSH 的目录 worker 用的是 104 = PICKFOLDERS(0x20) | FORCEFILESYSTEM(0x40)
 * | PATHMUSTEXIST(0x08)。这里去掉 PICKFOLDERS，换成 FILEMUSTEXIST。
 */
export const FILE_DIALOG_OPTIONS = 0x1048

/** 对话框默认标题。 */
export const DEFAULT_PICK_TITLE = '选择要启动的程序'

/** worker 脚本路径：和本模块同目录。 */
const WORKER_PATH = fileURLToPath(new URL('./picker-worker.cjs', import.meta.url))

/**
 * 选一个「能安全跑 koffi 的 Node」来起 worker。
 *
 * 桌面端的 host 跑在 **Electron 的 Node** 里（`process.versions.electron` 存在）。
 * 实测：worker 在 Electron-as-Node 下走到 `koffi.view()`（读所选路径那一步）会
 * 触发 `napi_is_detached_arraybuffer` **原生崩溃（SIGABRT/134）**——对话框正常弹出、
 * 用户正常点「打开」，然后 worker 悄悄死掉，宿主只能报「未返回结果就退出了」。
 * 纯 Node 下同段代码完全正常，所以这不是 koffi 用法错误，是 koffi 的二进制和
 * Electron 的 N-API 不兼容。
 *
 * 解法：**别用 Electron 的 Node 跑这个 worker**，改用 DSH 自带的独立 Node 运行时
 * （`$DSH_HOME/dsh-runtimes/<rt>/dependencies/node/bin/node`，和 CLI 用的同一个）。
 *
 * - 本插件已安装在 `$DSH_HOME/profiles/<p>/node_modules/` 下，向上三级就是
 *   `$DSH_HOME`，所以不用猜路径；再加 `DSH_HOME` 环境变量和 `~/.dsh` 兜底。
 * - `DSH_PICKER_NODE` 可以显式指定（测试或特殊部署用）。
 * - 非 Electron 宿主（web profile 走普通 node CLI）直接用 `process.execPath`，
 *   那条路昨天已经实测通过，保持原样。
 * @param {{ env?: Record<string, string|undefined>, isElectron?: boolean, execPath?: string, homes?: string[] }} [options] - 可注入项，便于单测（`homes` 覆盖搜索根）。
 * @returns {string} 可执行文件路径。
 */
export function resolveNodeBinary(options = {}) {
  const env = options.env ?? process.env
  const isElectron = options.isElectron ?? Boolean(process.versions.electron)
  const execPath = options.execPath ?? process.execPath

  const override = env.DSH_PICKER_NODE
  if (typeof override === 'string' && override !== '' && existsSync(override)) return override
  if (!isElectron) return execPath

  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  const homes = options.homes ?? [env.DSH_HOME, join(homedir(), '.dsh')]
    .filter((value) => typeof value === 'string' && value !== '')
  const seen = new Set()
  for (const home of homes) {
    if (seen.has(home)) continue
    seen.add(home)
    const runtimes = join(home, 'dsh-runtimes')
    if (!existsSync(runtimes)) continue
    let names
    try {
      names = readdirSync(runtimes)
    } catch {
      continue
    }
    for (const name of names) {
      const candidate = join(runtimes, name, 'dependencies', 'node', 'bin', exe)
      if (existsSync(candidate)) return candidate
    }
  }
  // 找不到独立运行时只能退回 execPath —— Electron 下 worker 大概率会在
  // koffi.view 处崩溃，调用方会收到明确的 500，而不是静默成功。
  return execPath
}

/**
 * 探测这台 host 能不能弹原生对话框。
 *
 * 只做「koffi 能不能 import」这一件事 —— 它是唯一的硬依赖（Windows 上的 COM 调用
 * 全靠它）。非 Windows 直接不支持：这个插件的原生选择器只实现了 win32 一条路。
 * @param {() => boolean} [isWindows] - 平台判定，测试时可注入。
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>} 探测结果。
 */
export async function isFilePickerSupported(isWindows = () => process.platform === 'win32') {
  if (!isWindows()) {
    return { ok: false, reason: '原生文件选择框目前只支持 Windows' }
  }
  try {
    await import('koffi')
    return { ok: true }
  } catch {
    return { ok: false, reason: '宿主缺少 koffi，无法弹出系统文件选择框' }
  }
}

/**
 * 弹一次原生文件选择框并等结果。
 *
 * `signal` 中止时会杀掉子进程，对话框随之消失 —— 这覆盖了「用户关了浏览器页面」
 * 的情况：请求连接断开，路由那边 abort，对话框不该继续挂在屏幕上。
 * @param {{ title?: string, signal?: AbortSignal }} [options] - 标题与取消信号。
 * @returns {Promise<string | null>} 选中的绝对路径；用户取消时 null。
 */
export async function pickFile(options = {}) {
  const { title = DEFAULT_PICK_TITLE, signal } = options
  if (signal?.aborted) throw new Error('file picker aborted')

  const child = spawn(resolveNodeBinary(), [WORKER_PATH], {
    env: { ...process.env, DSH_PICK_TITLE: title },
    // stdin 忽略、输出继承、额外开一条 IPC —— 和 DSH 的 dialog worker 同样的形状。
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  })

  return await new Promise((resolve, reject) => {
    let settled = false
    const settle = (outcome) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      // 别让这个子进程把 host 的事件循环拖住。
      child.unref?.()
      outcome()
    }
    const onAbort = () => {
      child.kill()
      settle(() => reject(new Error('file picker aborted')))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.on('message', (message) => {
      if (message?.kind === 'done') {
        settle(() => resolve(typeof message.path === 'string' && message.path !== '' ? message.path : null))
      } else if (message?.kind === 'error') {
        settle(() => reject(new Error(`文件选择框失败：${message.message}`)))
      }
      // `showing` 只是通知，不用处理：关对话框靠 kill 子进程就够了。
    })
    child.on('error', (error) => settle(() => reject(error)))
    // 不在 'exit' 上判失败：worker 在发完 done 后立刻退出，'exit' 有可能抢在
    // IPC 消息投递之前到，那样会把成功误判成失败。'close' 在所有 stdio/IPC 流
    // 关闭后才发，此时要么消息已经处理过（settled），要么真的一条都没有。
    child.on('close', (code) => {
      settle(() => reject(new Error(`文件选择框进程未返回结果就退出了（code=${code}）`)))
    })
  })
}
