/**
 * dsh-bilibili-break —— 摸鱼插件（host 半边）。
 *
 * 两个职责：
 *
 * 1. **自动打开**：观察 `session/event` 的 `turn/start` / `turn/end`。一轮开始时挂一个
 *    延迟定时器；如果这轮在延迟内就结束（寒暄、一次快速工具调用），定时器被撤掉，
 *    什么都不发生。只有真的忙过 `delaySeconds` 才用系统默认浏览器打开 `url`。
 *    三重防线避免刷屏：delaySeconds / cooldownSeconds / maxOpensPerSession。
 *
 * 2. **启动器路由**：客户端（浏览器侧）不能打开本地程序，所以在这里注册两条同源
 *    路由，让界面里的「自定义启动」能落到系统上。见下面 launch 区域的注释。
 *
 * 所有副作用都挂在插件 fiber 上（ctx.on / ctx.timeout / ctx.inject），卸载时自动回收。
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { pickFile, isFilePickerSupported, DEFAULT_PICK_TITLE } from './lib/picker.js'

/** 插件行名，与 package.json 的 name 一致，方便日志定位。 */
export const name = 'bilibili-break'

/**
 * 依赖 cordis 的 timer 服务（由 @deepseek-ai/dsh-base 挂载），拿 ctx.timeout。
 *
 * 注意：作为 profile bundle 挂载时，**loader 读的是补丁行上的 `inject`**
 * （见 cordis.patch.yml），这个导出只对直接 `ctx.plugin(plugin)` 生效（测试用）。
 * 两者都要有，缺了补丁行那一份，监听器里的 `ctx.timeout` 会抛
 * `cannot get property "timer" without inject`，而且被事件派发静默吞掉。
 */
export const inject = ['timer']

/** 启动器路由前缀。`/_dsh/` 是插件自有路由的约定前缀。 */
export const ROUTE_PREFIX = '/_dsh/bilibili-break'

/** 请求体上限：启动请求只该带一个地址和几个参数。 */
const MAX_BODY_BYTES = 16384

/** 明确拒绝的 scheme：这些不是「交给系统打开一个地址」。 */
const DENIED_OPEN_SCHEMES = new Set(['file', 'javascript', 'data', 'vbscript', 'blob'])

/** 配置缺省值；Config schema 未提供时也要能正常工作。 */
export const DEFAULT_CONFIG = {
  enabled: true,
  url: 'https://www.bilibili.com',
  delaySeconds: 10,
  cooldownSeconds: 600,
  maxOpensPerSession: 3,
  openInBrowser: true,
  allowOpen: true,
  allowExec: false,
  execAllowlist: [],
  /**
   * 是否信任「面板里当场选定的 exe 路径」（点「浏览…」或亲手填的那种）。
   *
   * 这是产品决定：让用户不为每个新软件去改配置文件。代价是把安全边界从「部署者写的
   * 静态名单」放宽到「面板即信任」—— 两者其实同一个信任域（面板本来就能调用
   * allowOpen 打开任意协议），但放宽的部分是显式的、可关的。
   */
  trustPanelPickedExec: true,
  /**
   * 闸门探针：把每次 `/hello` / `/launch` / `/pick-file` 的原始请求头和闸门判决
   * 追加写进 `$TMPDIR/dsh-bilibili-break-fence.ndjson`。
   *
   * 存在的理由就是那次桌面端 403 事故：客户端只报得上 `HTTP 403`，而服务端到底
   * 收到了什么头、被哪一条规则拒的，事后完全无从得知。有这个开关，下次诊断只需要
   * 你点一次按钮。默认关（诊断时在 profile 补丁里临时打开）。
   */
  fenceProbe: false,
  /**
   * 额外信任的非环回 authority（`host` 或 `host:port`，裸 authority，和 DSH 自家
   * `trustedHosts` 同语义）。闸门默认只认环回 Host；通过局域网访问 DSH 的部署者
   * 需要让面板的 host 路由可用时，把它的 authority 写在这里。
   */
  launcherTrustedHosts: [],
}

/**
 * 把任意来源的原始配置收敛成一份合法的、字段齐全的配置。
 * `apply` 在测试里会被直接调用，所以不能假设上游 schema 已经填过默认值。
 * @param {unknown} raw - 补丁行 `config` 或调用方传入的对象。
 * @returns {typeof DEFAULT_CONFIG} 归一化后的配置。
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const nonNegative = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
  const url = typeof source.url === 'string' ? source.url.trim() : ''
  const allowlist = Array.isArray(source.execAllowlist)
    ? source.execAllowlist.filter((item) => typeof item === 'string' && item.trim() !== '')
    : []
  return {
    enabled: source.enabled !== false,
    url: url === '' ? DEFAULT_CONFIG.url : url,
    delaySeconds: nonNegative(source.delaySeconds, DEFAULT_CONFIG.delaySeconds),
    cooldownSeconds: nonNegative(source.cooldownSeconds, DEFAULT_CONFIG.cooldownSeconds),
    maxOpensPerSession: nonNegative(source.maxOpensPerSession, DEFAULT_CONFIG.maxOpensPerSession),
    openInBrowser: source.openInBrowser !== false,
    allowOpen: source.allowOpen !== false,
    // 默认关：这是「浏览器里的代码能让你的电脑执行程序」，必须显式打开。
    allowExec: source.allowExec === true,
    execAllowlist: allowlist,
    // 默认开：让面板里选定的程序免去手改配置文件。见 DEFAULT_CONFIG 里的说明。
    trustPanelPickedExec: source.trustPanelPickedExec !== false,
    // 诊断开关，默认关；开了才会写探针文件。
    fenceProbe: source.fenceProbe === true,
    launcherTrustedHosts: Array.isArray(source.launcherTrustedHosts)
      ? source.launcherTrustedHosts.filter((item) => typeof item === 'string' && item.trim() !== '')
      : [],
  }
}

// ── 自动打开的决策（纯函数，便于单测） ────────────────────────────────────────

/**
 * 纯决策函数：这一轮到底该不该开浏览器。
 * @param {object} input - 决策输入。
 * @param {ReturnType<typeof normalizeConfig>} input.config - 归一化配置。
 * @param {number} input.now - 当前时间戳（毫秒）。
 * @param {number} input.lastOpenedAt - 上一次打开的时间戳，0 表示从未打开。
 * @param {number} input.opensThisSession - 本会话已经打开的次数。
 * @returns {{ open: boolean, reason: string }} 决策与人类可读的原因。
 */
export function decideOpen({ config, now, lastOpenedAt, opensThisSession }) {
  if (!config.enabled) return { open: false, reason: '插件已禁用' }

  if (config.maxOpensPerSession > 0 && opensThisSession >= config.maxOpensPerSession) {
    return { open: false, reason: `已达单会话上限 ${opensThisSession}/${config.maxOpensPerSession}` }
  }

  if (lastOpenedAt > 0) {
    const waitMs = config.cooldownSeconds * 1000
    const elapsed = now - lastOpenedAt
    if (elapsed < waitMs) {
      return { open: false, reason: `冷却中，还需 ${Math.ceil((waitMs - elapsed) / 1000)}s` }
    }
  }

  return { open: true, reason: 'ok' }
}

/**
 * 算出「用系统默认处理程序打开某地址」的可执行文件与参数。
 *
 * Windows 刻意不走 `cmd /c start`：URL 会经过 cmd 的二次解析，查询串里的 `&`
 * 会被当成命令分隔符。`rundll32 url.dll,FileProtocolHandler` 直接把地址当作
 * 单个进程参数交给 shell 关联程序，没有这层风险。
 * @param {string} url - 要打开的地址（也用于 steam:// 这类协议）。
 * @param {string} [platform] - 平台标识，默认取当前进程。
 * @returns {{ command: string, args: string[] }} 传给 spawn 的实参与参数。
 */
export function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') {
    return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
  }
  if (platform === 'darwin') return { command: 'open', args: [url] }
  return { command: 'xdg-open', args: [url] }
}

/**
 * 交给系统默认处理程序打开地址，不等待、不继承 stdio，也不因失败而抛出。
 * @param {string} url - 要打开的地址。
 * @param {(message: string) => void} [onError] - 启动失败时的回调。
 * @returns {boolean} 是否成功发起了 spawn。
 */
export function launchBrowser(url, onError) {
  const { command, args } = browserCommand(url)
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', (error) => onError?.(String(error?.message ?? error)))
    child.unref()
    return true
  } catch (error) {
    onError?.(String(error?.message ?? error))
    return false
  }
}

// ── 启动器：请求校验（纯函数，便于单测） ──────────────────────────────────────

/** 控制字符会污染进程参数与日志，一律拒绝。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/**
 * `host` 头里的 authority 是不是环回地址。
 *
 * 这是防 DNS rebinding 的主门：攻击者页面把自己的域名 rebind 到 127.0.0.1 后，
 * `sec-fetch-site` 会是 `same-origin`、`Origin` 也会匹配——**只有 Host 还是攻击者
 * 的域名**（浏览器从 URL 填 Host，rebind 改不了它）。所以 Host 必须绑死环回。
 * @param {string} host - Host 头的 authority。
 * @returns {boolean} 是否环回。
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string' || host === '') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return false
  }
  // WHATWG 对 IPv6 保留方括号：`new URL('http://[::1]:1').hostname === '[::1]'`。
  if (hostname === '[::1]' || hostname === '::1') return true
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  // 127.0.0.0/8 整段都是环回。
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

/**
 * 请求闸门：方法 + Host 环回绑定 + 跨源标记 + Origin 一致性。
 *
 * 模型对齐 DSH 自家 `/api` 的信任判定（`api-request-trust.ts`），而不是更早版本
 * 那个「`sec-fetch-site` 必须存在且必须是 same-origin/none」的版本——那个版本把
 * **桌面端自己的窗口**打死了：Electron 自定义协议页面对本机 http 服务的 fetch 并不
 * 一定带同源标记，缺头直接 403，于是「浏览…」和启动全都握手失败（这是一次真实
 * 线上事故，不是理论风险）。
 *
 * 逐条：
 *
 * 1. 方法固定 → 405（顺带掐掉跨站表单提交）；
 * 2. `Host` 必须存在且可解析 → 403；
 * 3. `Host` 必须是环回（或命中 `trustedHosts`）→ 403。**rebind 防御的主门**；
 * 4. `sec-fetch-site` 若显式是 `cross-site` → 403。现代浏览器给每个 fetch 打发起方
 *    关系标记，攻击者页面必然是 cross-site——这是**CSRF 主门**；
 * 5. `sec-fetch-site` 存在**且** `Origin` 存在时，Origin 的 authority 必须等于 Host →
 *    403。头缺失（curl、Electron 的非标准窗口）时跳过这条：能到 Host 环回这一关的
 *    本机请求没有 CSRF 面（浏览器侧的 CSRF 都带标记，被第 4 条挡住），POST 还有
 *    token 兜底。
 *
 * @param {{ method?: string, headers?: Record<string, unknown> }} req - 请求事实。
 * @param {string} expectedMethod - 该路由唯一接受的方法。
 * @param {{ trustedHosts?: readonly string[] }} [options] - 额外信任的非环回 authority。
 * @returns {{ ok: true } | { ok: false, status: number, error: string }} 判定结果。
 */
export function checkRequestFence(req, expectedMethod, options = {}) {
  if (req?.method !== expectedMethod) {
    return { ok: false, status: 405, error: `only ${expectedMethod} is accepted` }
  }
  const host = typeof req?.headers?.host === 'string' ? req.headers.host : ''
  if (host === '' || !isLoopbackHost(host)) {
    const trusted = Array.isArray(options.trustedHosts) ? options.trustedHosts : []
    let hostUrl
    try {
      hostUrl = host === '' ? undefined : new URL(`http://${host}`)
    } catch {
      hostUrl = undefined
    }
    const isTrusted = hostUrl !== undefined && trusted.some((entry) => {
      try {
        return new URL(`http://${entry}`).host === hostUrl.host
      } catch {
        return false
      }
    })
    if (host === '' || !isTrusted) {
      return { ok: false, status: 403, error: 'host must be a loopback authority' }
    }
  }
  const site = String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') {
    return { ok: false, status: 403, error: 'cross-origin request rejected' }
  }
  if (site !== '') {
    const origin = req?.headers?.origin
    if (typeof origin === 'string' && origin !== '') {
      let originUrl
      try {
        originUrl = new URL(origin)
      } catch {
        // 含字面量 "null"（沙箱 iframe、file: 页面的不透明源）。
        return { ok: false, status: 403, error: 'origin does not match host' }
      }
      if (originUrl.host !== hostUrlOf(host).host) {
        return { ok: false, status: 403, error: 'origin does not match host' }
      }
    }
  }
  return { ok: true }
}

/** Host authority 解析成 URL；不可解析时返回可比较的空对象。 */
function hostUrlOf(host) {
  try {
    return new URL(`http://${host}`)
  } catch {
    return { host: '' }
  }
}

/**
 * `open` 类目标是否合法：必须是一个带 scheme 的地址。
 *
 * 这一类只是「把地址交给系统关联程序」，和打开网页同一量级，所以不需要额外开关。
 * 但 `file:`/`data:`/`javascript:` 不是这个语义 —— 本地文件请走 `exec`，那里有
 * 独立开关和 allowlist。
 * @param {unknown} target - 客户端给的地址。
 * @returns {boolean} 是否放行。
 */
export function isAllowedOpenTarget(target) {
  if (typeof target !== 'string') return false
  const value = target.trim()
  if (value === '' || value.length > 2048) return false
  if (CONTROL_CHARS.test(value)) return false
  // scheme 必须至少两个字符：RFC 3986 虽然允许单字母 scheme，但现实中不存在，
  // 而单字母恰好会把 Windows 盘符（`C:\Windows\...`）误判成 scheme `c` 而放行。
  const match = /^([a-z][a-z0-9+.-]+):/i.exec(value)
  if (match === null) return false
  return !DENIED_OPEN_SCHEMES.has(match[1].toLowerCase())
}

/**
 * `exec` 类目标是否合法。allowlist 为空表示「用户在配置里显式打开了 allowExec，
 * 且没有进一步收窄」——此时放行任意可执行文件；非空则只放行名单内的。
 * @param {unknown} target - 可执行文件路径或命令名。
 * @param {readonly string[]} [allowlist] - 配置里的允许名单。
 * @returns {boolean} 是否放行。
 */
export function isAllowedExecTarget(target, allowlist = []) {
  if (typeof target !== 'string') return false
  const value = target.trim()
  if (value === '' || value.length > 1024) return false
  if (CONTROL_CHARS.test(value)) return false
  if (allowlist.length === 0) return true
  const lowered = value.toLowerCase()
  return allowlist.some((entry) => {
    const allowed = String(entry).trim().toLowerCase()
    if (allowed === '') return false
    return lowered === allowed || lowered.endsWith(`\\${allowed}`) || lowered.endsWith(`/${allowed}`)
  })
}

/** 参数数组：元素必须是普通字符串，且总量有界。 */
export function isAllowedArgs(args) {
  if (!Array.isArray(args)) return false
  if (args.length > 32) return false
  return args.every((arg) => typeof arg === 'string' && arg.length <= 512 && !CONTROL_CHARS.test(arg))
}

/**
 * 校验一条启动请求的**结构**。纯函数：只吃普通数据，不碰网络和进程。
 *
 * 这里刻意**不**判 allowlist：那是 `authorizeExec` 的职责，因为它还要看运行时信任
 * 集合。两边分开才能让「面板里选过的路径」这条路走得通 —— 早期版本在这里就把
 * 非名单目标拒了，结果信任集合永远没机会生效。
 * @param {unknown} body - 已解析的请求体。
 * @returns {{ ok: true, action: 'open'|'exec', target: string, args: string[], userChosen: boolean }
 *   | { ok: false, error: string }} 判定结果。
 */
export function parseLaunchRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const action = body.action
  // 目标是不是由面板里的人显式选定（「浏览…」或亲手填的路径）。只有 exec 用得上：
  // 它决定这条路径要不要进运行时信任集合。缺省 false，即按「自动」从严对待。
  const userChosen = body.userChosen === true
  if (action === 'open') {
    if (!isAllowedOpenTarget(body.target)) {
      return { ok: false, error: 'target must be a URL with a scheme (file:, data: and javascript: are rejected)' }
    }
    return { ok: true, action, target: body.target.trim(), args: [], userChosen }
  }
  if (action === 'exec') {
    if (typeof body.target !== 'string' || body.target.trim() === '' || body.target.length > 1024) {
      return { ok: false, error: 'target must be a non-empty path string' }
    }
    const args = body.args === undefined ? [] : body.args
    if (!isAllowedArgs(args)) return { ok: false, error: 'args must be an array of short plain strings' }
    return { ok: true, action, target: body.target.trim(), args: [...args], userChosen }
  }
  return { ok: false, error: 'action must be "open" or "exec"' }
}

/**
 * 路径归一化：用于「同一条路径」的比较。
 *
 * Windows 路径大小写不敏感，用户从对话框拿到的是 `C:\...`、手打可能写成 `c:/...`，
 * 所以统一斜杠并折成小写再比。
 * @param {string} value - 原始路径。
 * @returns {string} 归一化后的比较键。
 */
export function pathKey(value) {
  return String(value).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/**
 * 面板选定路径的运行时信任集合。
 *
 * 配置里的 `execAllowlist` 是**部署者**写的静态名单；这个集合是**操作者**在面板里
 * 当场选出来的路径。两者是不同层：前者防的是「页面被注入后乱执行」，后者是操作者
 * 本人的显式意图 —— 面板里点「浏览…」选中一个 exe，跟在配置文件里写一行，意图强度
 * 是一样的。
 *
 * 但意图必须真的是「人选的」：请求里 `userChosen` 为真才记。面板只在自己收到过
 * 用户动作（选文件、手打路径）时才会带上它，所以自动触发/重放的请求拿不到这条豁免。
 *
 * 集合只活在内存里，进程重启即清空 —— 持久化会让「哪天被写进去的路径」变成看不见
 * 的后门，而重启后重新选一次的成本极低。
 */
export class ExecTrustSet {
  /** @type {Set<string>} 归一化路径 */
  #keys = new Set()

  /** @type {Map<string, string>} 归一化路径 -> 原始写法，日志用 */
  #display = new Map()

  /**
   * 记下一条操作者选定的路径。
   * @param {string} target - 可执行文件路径。
   * @returns {boolean} 这次是不是**新增**（false 表示之前就记过）。
   */
  add(target) {
    const key = pathKey(target)
    if (this.#keys.has(key)) return false
    this.#keys.add(key)
    this.#display.set(key, target)
    return true
  }

  /**
   * 这条路径信任吗。
   * @param {string} target - 可执行文件路径。
   * @returns {boolean} 是否在集合内。
   */
  has(target) {
    return this.#keys.has(pathKey(target))
  }

  /** 当前条目数，日志/测试用。 */
  get size() {
    return this.#keys.size
  }

  /** 便于日志输出的原始路径列表。 */
  list() {
    return [...this.#display.values()]
  }
}

/**
 * 一条 exec 目标该不该放行。
 *
 * 放行条件：配置名单命中，**或**这条路径是操作者本次运行中显式选过的，**或**调用方
 * 明确允许「面板即信任」。最后那条对应配置项 `trustPanelPickedExec`，默认开 ——
 * 这就是「面板里加了就自动放行」那条产品决定。
 * @param {object} input - 判定输入。
 * @param {string} input.target - 可执行文件路径。
 * @param {boolean} input.userChosen - 请求是否声明由人选定。
 * @param {readonly string[]} input.execAllowlist - 配置里的静态名单。
 * @param {boolean} input.trustPanelPicked - 是否信任面板选定的路径。
 * @param {ExecTrustSet} input.trusted - 本次运行的信任集合。
 * @returns {{ ok: true, remembered: boolean } | { ok: false, error: string }} 判定结果。
 */
export function authorizeExec(input) {
  const { target, userChosen, execAllowlist, trustPanelPicked, trusted } = input

  // 名单为空 = 部署者显式打开 allowExec 且不再收窄，一律放行。
  // （isAllowedExecTarget 在空名单时返回 true，但这里先判是为了让意图一眼可见。）
  if (execAllowlist.length === 0) {
    return { ok: true, remembered: false }
  }

  // 命中配置里的静态名单。
  if (isAllowedExecTarget(target, execAllowlist)) {
    return { ok: true, remembered: false }
  }

  // 操作者本人在面板里选的，且部署者允许这种信任。
  if (userChosen && trustPanelPicked) {
    return { ok: true, remembered: trusted.add(target) }
  }

  // 之前选过同一条路径（比如换了个启动项重复触发）。
  if (trusted.has(target)) {
    return { ok: true, remembered: false }
  }

  return {
    ok: false,
    error: `「${target}」不在 execAllowlist 里。要启动它，请在面板的启动项里点「浏览…」选一次，或把路径加进插件配置的 execAllowlist。`,
  }
}

// ── 启动器：路由实现 ──────────────────────────────────────────────────────────

/** 统一的 JSON 响应；启动结果不该被任何缓存层留下。 */
function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/** 读并解析 JSON 请求体，超出上限直接拒绝。 */
async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 配置 schema：让 Web 的插件配置卡片能校验并展示这些开关。 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled),
  url: z.string().default(DEFAULT_CONFIG.url),
  delaySeconds: z.number().step(1).min(0).default(DEFAULT_CONFIG.delaySeconds),
  cooldownSeconds: z.number().step(1).min(0).default(DEFAULT_CONFIG.cooldownSeconds),
  maxOpensPerSession: z.number().step(1).min(0).default(DEFAULT_CONFIG.maxOpensPerSession),
  openInBrowser: z.boolean().default(DEFAULT_CONFIG.openInBrowser),
  allowOpen: z.boolean().default(DEFAULT_CONFIG.allowOpen),
  allowExec: z.boolean().default(DEFAULT_CONFIG.allowExec),
  execAllowlist: z.array(z.string()).default([]),
  trustPanelPickedExec: z.boolean().default(DEFAULT_CONFIG.trustPanelPickedExec),
  fenceProbe: z.boolean().default(DEFAULT_CONFIG.fenceProbe),
  launcherTrustedHosts: z.array(z.string()).default([]),
})

/** 会话对象只用来取一个稳定 id，绝不序列化或长期持有它。 */
function sessionIdOf(session) {
  const id = session?.id
  return typeof id === 'string' && id !== '' ? id : 'unknown-session'
}

/**
 * 挂载插件。
 *
 * 是 async 的：注册路由之前要先探一次原生文件选择框能不能用。cordis 支持异步
 * apply，`await` 在这里是安全的。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件 fiber 上下文。
 * @param {unknown} [rawConfig] - 补丁行 config。
 */
export async function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)

  /** sessionId -> 撤掉待触发定时器的函数。 */
  const pending = new Map()
  /** sessionId -> 已打开次数。 */
  const opensBySession = new Map()
  /** 面板里当场选定的 exe 路径，只活在本次运行。 */
  const trusted = new ExecTrustSet()
  let lastOpenedAt = 0

  ctx.logger?.info(
    'bilibili-break: 已挂载（延迟 %ds / 冷却 %ds / 单会话上限 %s）',
    config.delaySeconds,
    config.cooldownSeconds,
    config.maxOpensPerSession === 0 ? '不限' : config.maxOpensPerSession,
  )

  const disarm = (sessionId) => {
    const dispose = pending.get(sessionId)
    if (dispose === undefined) return
    dispose()
    pending.delete(sessionId)
  }

  const fire = (sessionId, turn) => {
    const opens = opensBySession.get(sessionId) ?? 0
    const verdict = decideOpen({
      config,
      now: Date.now(),
      lastOpenedAt,
      opensThisSession: opens,
    })

    if (!verdict.open) {
      ctx.logger?.info('bilibili-break: 第 %d 轮不打开（%s）', turn, verdict.reason)
      return
    }

    lastOpenedAt = Date.now()
    opensBySession.set(sessionId, opens + 1)

    if (!config.openInBrowser) {
      ctx.logger?.info('bilibili-break: [干跑] 本应打开 %s（第 %d 轮）', config.url, turn)
      return
    }

    const opened = launchBrowser(config.url, (message) =>
      ctx.logger?.warn('bilibili-break: 打开浏览器失败：%s', message),
    )
    if (opened) {
      ctx.logger?.info('bilibili-break: 第 %d 轮已忙过 %ds，打开 %s', turn, config.delaySeconds, config.url)
    }
  }

  ctx.on('session/event', (session, event) => {
    const type = event?.type
    if (type !== 'turn/start' && type !== 'turn/end') return
    const sessionId = sessionIdOf(session)

    if (type === 'turn/end') {
      // 这一轮在延迟内就收工了：人类没等多久，不打扰。
      disarm(sessionId)
      return
    }

    disarm(sessionId)
    const turn = typeof event.turn === 'number' ? event.turn : 0
    pending.set(
      sessionId,
      ctx.timeout(() => {
        pending.delete(sessionId)
        fire(sessionId, turn)
      }, config.delaySeconds * 1000),
    )
  })

  // 会话没了就把它残留的定时器和计数一起丢掉，避免 Map 无限增长。
  ctx.on('session/disposed', (session) => {
    const sessionId = sessionIdOf(session)
    disarm(sessionId)
    opensBySession.delete(sessionId)
  })

  // ── 启动器路由 ────────────────────────────────────────────────────────────
  //
  // 浏览器里的代码不能打开本地程序，所以「自定义启动」的 host/exec/exe 几类目标必须
  // 回到 host 执行。这里注册三条同源路由，三道门：
  //
  //   1. 方法固定（hello 只 GET、其余只 POST）—— 顺带掐掉跨站表单提交；
  //   2. checkRequestFence —— Host 必须环回（防 DNS rebinding）+ 拒绝显式
  //      cross-site 标记（防 CSRF）+ Origin 一致性。模型对齐 DSH 自家 /api
  //      （见 checkRequestFence 的注释，旧版「头必须存在」打死了桌面端窗口）；
  //   3. 每次启动生成的随机 token，走自定义请求头 —— 纵深防御，只在 POST 要求。
  //
  // `open` 只接受带 scheme 的地址（交给系统关联程序，和打开网页同一量级）；
  // `exec` 是真正 spawn 程序，所以要 `allowExec` 显式打开，还可以用
  // `execAllowlist` 进一步收窄。默认全关。

  const launchToken = randomBytes(24).toString('base64url')

  // ── 闸门探针（config.fenceProbe，默认关）────────────────────────────────
  //
  // 客户端只报得上「HTTP 403」，服务端收到了什么头、被哪条规则拒的，事后无从得知
  // ——桌面端那次握手事故就是这么查了半天。开关打开后，每次请求的原始头和判决都
  // 追加进一个 ndjson 文件，下次诊断只需要点一次按钮。
  const PROBE_PATH = join(tmpdir(), 'dsh-bilibili-break-fence.ndjson')

  /** 从请求里抽诊断要用的头（只记相关字段，不落请求体）。 */
  const probeHeaders = (req) => ({
    host: req?.headers?.host ?? null,
    origin: req?.headers?.origin ?? null,
    'sec-fetch-site': req?.headers?.['sec-fetch-site'] ?? null,
    'sec-fetch-dest': req?.headers?.['sec-fetch-dest'] ?? null,
    'sec-fetch-mode': req?.headers?.['sec-fetch-mode'] ?? null,
    'user-agent': req?.headers?.['user-agent'] ?? null,
  })

  /** 追加一行探针记录；探针文件本身坏了不能影响请求处理。 */
  const probe = (route, req, verdict) => {
    if (!config.fenceProbe) return
    try {
      appendFileSync(PROBE_PATH, `${JSON.stringify({ t: new Date().toISOString(), route, verdict, headers: probeHeaders(req) })}\n`, 'utf8')
    } catch {
      // 只读临时目录之类的极端情况：探针是诊断工具，失败不影响主流程。
    }
  }

  if (config.fenceProbe) {
    // 每次启动重新开始，避免历史记录误导诊断。
    try {
      writeFileSync(PROBE_PATH, '', 'utf8')
      ctx.logger?.info('bilibili-break: 闸门探针已开启，记录在 %s', PROBE_PATH)
    } catch {
      ctx.logger?.warn('bilibili-break: 闸门探针无法初始化（%s）', PROBE_PATH)
    }
  }

  /**
   * 三道门里最外层的那道：方法 + 信任闸门 [+ token]。三条路由共用。
   *
   * token 只在 POST 路由上要求 —— `/hello` 本身是 token 的来源，不能要求先有 token
   * （否则是死循环：客户端永远拿不到握手）。`/hello` 依然受方法 + Host/跨源闸门保护。
   * @param {object} req - 请求。
   * @param {object} res - 响应。
   * @param {'GET'|'POST'} method - 该路由唯一接受的方法。
   * @param {string} route - 路由名（探针记录用）。
   * @returns {boolean} 通过返回 true；否则已经写过响应，调用方直接 return。
   */
  const passFence = (req, res, method, route) => {
    const fence = checkRequestFence(req, method, { trustedHosts: config.launcherTrustedHosts })
    if (!fence.ok) {
      // 405 必须带 Allow（RFC 9110）。
      if (fence.status === 405) res.setHeader('Allow', method)
      ctx.logger?.warn('bilibili-break: %s 请求被闸门拒绝（%d %s）', route, fence.status, fence.error)
      probe(route, req, `fence:${fence.status}:${fence.error}`)
      sendJson(res, fence.status, { ok: false, error: fence.error })
      return false
    }
    if (method === 'GET') {
      probe(route, req, 'ok')
      return true
    }
    const token = String(req.headers?.['x-dsh-bilibili-break-token'] ?? '')
    if (token === '' || token !== launchToken) {
      ctx.logger?.warn('bilibili-break: %s 请求 token 无效', route)
      probe(route, req, 'token-403')
      sendJson(res, 403, { ok: false, error: 'invalid launcher token' })
      return false
    }
    probe(route, req, 'ok')
    return true
  }

  // 原生文件选择框能不能用，启动时探一次就够（koffi 不会中途出现或消失）。
  // 探测本身是异步的，所以在注册路由之前 await；失败也不影响其它功能。
  let pickerSupport
  try {
    pickerSupport = await isFilePickerSupported()
  } catch (error) {
    pickerSupport = { ok: false, reason: String(error?.message ?? error) }
  }
  if (!pickerSupport.ok) {
    ctx.logger?.info('bilibili-break: 原生文件选择框不可用（%s），面板会退回手填路径', pickerSupport.reason)
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/hello`,
          handler: (req, res) => {
            if (!passFence(req, res, 'GET', 'hello')) return
            sendJson(res, 200, {
              ok: true,
              token: launchToken,
              capabilities: {
                open: config.allowOpen,
                exec: config.allowExec,
                // 客户端据此决定「浏览…」按钮是可用还是隐藏。
                pickable: pickerSupport.ok,
              },
            })
          },
        }),
      'bilibili-break: launcher handshake',
    )

    // 原生「选择文件」对话框。桌面端能弹；网页端浏览器到不了宿主屏幕，此刻
    // pickerSupport.ok 为假，这条路由会 501 并说明原因，面板退回手填。
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/pick-file`,
          handler: async (req, res) => {
            if (!passFence(req, res, 'POST', 'pick-file')) return
            if (!pickerSupport.ok) {
              sendJson(res, 501, { ok: false, unsupported: pickerSupport.reason })
              return
            }

            let body
            try {
              body = await readJsonBody(req)
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
              return
            }
            const title = typeof body.title === 'string' && body.title.trim() !== ''
              ? body.title.trim().slice(0, 120)
              : DEFAULT_PICK_TITLE

            // 客户端断开（关页面/关面板）就关掉对话框：AbortController 挂到响应的
            // close 事件上。没有这一条，用户关掉页面后对话框会孤零零留在屏幕上。
            const abort = new AbortController()
            res.on('close', () => abort.abort())

            try {
              const path = await currentPicker()({ title, signal: abort.signal })
              if (abort.signal.aborted) return
              // path 为 null = 用户取消，这不算错误。
              sendJson(res, 200, { ok: true, path })
            } catch (error) {
              if (abort.signal.aborted) return
              ctx.logger?.warn('bilibili-break: 文件选择框失败：%s', String(error?.message ?? error))
              sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      'bilibili-break: native file picker',
    )

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/launch`,
          handler: async (req, res) => {
            if (!passFence(req, res, 'POST', 'launch')) return

            let body
            try {
              body = await readJsonBody(req)
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
              return
            }

            const parsed = parseLaunchRequest(body)
            if (!parsed.ok) {
              sendJson(res, 400, { ok: false, error: parsed.error })
              return
            }
            if (parsed.action === 'open') {
              if (!config.allowOpen) {
                sendJson(res, 403, { ok: false, error: 'allowOpen is disabled in the plugin config' })
                return
              }
              const started = launchBrowser(parsed.target, (message) =>
                ctx.logger?.warn('bilibili-break: 系统打开失败：%s', message),
              )
              if (!started) {
                sendJson(res, 500, { ok: false, error: 'could not hand the target to the OS' })
                return
              }
              ctx.logger?.info('bilibili-break: 交给系统打开 %s', parsed.target)
              sendJson(res, 200, { ok: true })
              return
            }

            if (!config.allowExec) {
              sendJson(res, 403, { ok: false, error: 'allowExec is disabled in the plugin config' })
              return
            }

            const verdict = authorizeExec({
              target: parsed.target,
              userChosen: parsed.userChosen,
              execAllowlist: config.execAllowlist,
              trustPanelPicked: config.trustPanelPickedExec,
              trusted,
            })
            if (!verdict.ok) {
              sendJson(res, 403, { ok: false, error: verdict.error })
              return
            }
            if (verdict.remembered) {
              // 记一条 info：运行时信任集合是放宽了口径的那部分，出问题时这里能看出
              // 到底是哪次操作把哪条路径放进来的。
              ctx.logger?.info(
                'bilibili-break: 记住面板选定的程序 %s（本次共 %d 条）',
                parsed.target,
                trusted.size,
              )
            }

            try {
              const child = spawn(parsed.target, parsed.args, {
                detached: true,
                stdio: 'ignore',
                windowsHide: false,
                // 不走 shell：参数不会被二次解析，注入面只剩 argv 本身。
                shell: false,
              })
              child.on('error', (error) =>
                ctx.logger?.warn('bilibili-break: 启动程序失败：%s', String(error?.message ?? error)),
              )
              child.unref()
              ctx.logger?.info('bilibili-break: 已启动 %s（%d 个参数）', parsed.target, parsed.args.length)
              sendJson(res, 200, { ok: true })
            } catch (error) {
              sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      'bilibili-break: launcher route',
    )
  })
}

export default apply

// ── 测试缝 ────────────────────────────────────────────────────────────────────

/**
 * 覆盖原生文件选择器的实现，仅供测试。
 *
 * 不这样做的话，打一次 `/pick-file` 就会弹出一个**真的**模态对话框并一直等在那里
 * —— 测试会挂死（而且会在开发者的屏幕上留下窗口）。这个缝让测试能确定性地驱动
 * 「选中」「取消」「报错」三条路径。
 *
 * 传 `null` 恢复真实实现。生产代码从不碰它。
 * @type {null | ((options: { title?: string, signal?: AbortSignal }) => Promise<string | null>)}
 */
let pickerOverrideImpl = null

/**
 * 装上/卸下文件选择器的测试替身。
 * @param {null | ((options: { title?: string, signal?: AbortSignal }) => Promise<string | null>)} impl - 替身。
 */
export function __setPickerImpl(impl) {
  pickerOverrideImpl = impl
}

/** 当前生效的选择器实现（替身优先）。 */
function currentPicker() {
  return pickerOverrideImpl ?? pickFile
}
