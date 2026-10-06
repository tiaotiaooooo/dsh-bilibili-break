/**
 * dsh-bilibili-break —— 浏览器侧（桌面端的 GUI 就是同一套 Web 界面，所以两端通用）。
 *
 * 挂在 `shell.overlay` 这个根作用域的加性浮动层上。它由 ui-layout 声明，文档明确
 * 说明它是给「frame-wide surface of your own」用的，且图层本身点击穿透——所以
 * 交互元素要自己 opt-in pointer-events。
 *
 * 运行态直接读框架给的标准 props：根作用域组件的 `useSessions` 选择器是
 * `SessionListState`。**注意不能只认 `state.current`**：在「新会话」视图下它是
 * undefined 而 turn 已经在跑了（实测），只认 current 会让弹窗永远不出现。
 *
 * 「自定义启动」的四类目标：
 *   embed —— 在面板里 iframe 打开（不抢焦点）；targets 可以有多条，就是播放列表
 *   tab   —— 新标签页打开
 *   host  —— 交给 host 用系统默认处理程序打开 URL/协议（steam:// 之类）
 *   exec  —— 交给 host spawn 可执行文件；host 侧默认关闭，需显式打开 allowExec
 * 后两类必须回 host 执行，走 `/_dsh/bilibili-break/launch`（同源 + token）。
 *
 * 配置存 localStorage：客户端插件读不到 host 插件的 config，而启动项本来就是
 * 浏览器侧的个人偏好，放这儿反而让桌面端和网页端共享同一套行为。
 *
 * 这个文件是手写的浏览器 bundle，不经过打包器：模块系统用
 * `window.__ModuleLoader__.load({ id, factory })` 包一层 CJS factory，外部依赖从
 * 冻结的模块表里 require。
 */

window.__ModuleLoader__.load({
  id: 'dsh-bilibili-break',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** 模块 id：必须和 `window.__ModuleLoader__.load({ id })` 一致。 */
    const PLUGIN_ID = 'dsh-bilibili-break'

    /** slot 条目 id：与 cordis 插件行 id 同名，在 shell.overlay 里唯一即可。 */
    const ENTRY_ID = 'bilibili-break'

    /** agent 忙过这么久之后才弹询问。 */
    const ASK_DELAY_MS = 10000

    /** 片单与偏好的持久化键。 */
    const STORAGE_KEY = 'dsh-bilibili-break/v1'

    /** 与 host 半边 ROUTE_PREFIX 必须一致。 */
    const ROUTE_PREFIX = '/_dsh/bilibili-break'

    /** 自定义启动支持的五类目标。 */
    const ENTRY_KINDS = ['embed', 'tab', 'host', 'exe', 'exec']

    const KIND_LABEL = {
      embed: '面板内嵌',
      tab: '新标签页',
      host: '系统打开',
      exe: '启动软件',
      exec: '执行程序',
    }

    const KIND_HINT = {
      embed: '在摸鱼面板里 iframe 打开，不抢焦点。每行一条，可切歌/随机。',
      tab: '用新标签页打开，适合不允许 iframe 的网站。只取第一行。',
      host: '交给 host 用系统默认处理程序打开，比如 steam://run/730、spotify:。只取第一行。',
      exe: '启动本机软件。点「浏览…」选 exe，也可以直接粘路径。只取第一行。',
      exec: '交给 host 执行可执行文件。host 侧默认关闭，需要显式打开 allowExec。只取第一行。',
    }

    /**
     * 需要走 host `exec` 的启动类型。
     *
     * `exe` 和 `exec` 在 host 侧是同一个动作，区别只在客户端的编辑体验：`exe` 有
     * 「浏览…」按钮、文案里不提 allowExec。分开两个类型是为了不让改 `exec` 的
     * 定位（给懂配置的人一个原样入口）。
     */
    const EXEC_KINDS = ['exe', 'exec']

    /** 该启动类型是不是「执行本机程序」这一族。 */
    function isExecKind(kind) {
      return EXEC_KINDS.includes(kind)
    }

    /** 原生文件选择器路由（相对 ROUTE_PREFIX）。 */
    const PICK_FILE_ROUTE = `${ROUTE_PREFIX}/pick-file`

    // ── 持久化与数据模型 ──────────────────────────────────────────────────────

    const DEFAULT_SETTINGS = {
      version: 2,
      askEnabled: true,
      askText: 'AI 正在工作，来摸一会鱼吧~',
      /** 运行中右下角那个小胶囊的文案。和弹窗文案分开：位置与语气都不一样。 */
      pillText: 'AI 还在工作，摸一会鱼吧~',
      entries: [
        { id: 'bilibili', icon: '🎬', label: '刷 B站', kind: 'embed', targets: [], args: [] },
        { id: 'bilibili-home', icon: '🌐', label: 'B站 首页', kind: 'tab', targets: ['https://www.bilibili.com'], args: [] },
      ],
      activeEntryId: 'bilibili',
      cursors: {},
      /** 面板宽度（px）。拖动左下角可改，改了会记下来。 */
      panelWidth: 420,
      /** 嵌入区高度（px）。undefined = 按目标类型自动（视频 16:9、网页 16:10）。 */
      stageHeight: undefined,
      /** 面板离视口右边/下边的距离（px）。拖标题栏可移动。 */
      panelRight: 16,
      panelBottom: 16,
    }

    /**
     * 面板宽度预设。拖拽手柄只有 8px、不显眼，所以给一排点一下就能换的尺寸。
     * 选预设会清掉手动拖过的高度，回到该宽度下的自动横比例。
     */
    const SIZE_PRESETS = [
      { label: '窄', width: 360, hint: '少挡对话' },
      { label: '中', width: 420, hint: '默认' },
      { label: '宽', width: 560, hint: '字更大' },
      { label: '超宽', width: 720, hint: '接近网页原生宽度' },
    ]

    /** 把任意一条启动项收敛成合法形状；完全认不出来才返回 undefined。 */
    function normalizeEntry(raw) {
      if (raw === null || typeof raw !== 'object') return undefined
      const kind = ENTRY_KINDS.includes(raw.kind) ? raw.kind : 'embed'
      const targets = (Array.isArray(raw.targets) ? raw.targets : [])
        .filter((item) => typeof item === 'string' && item.trim() !== '')
        .map((item) => item.trim())
      const args = (Array.isArray(raw.args) ? raw.args : []).filter((item) => typeof item === 'string')
      const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `entry-${Math.random().toString(36).slice(2, 8)}`
      const label = typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : '未命名'
      const icon = typeof raw.icon === 'string' && raw.icon !== '' ? raw.icon : '🎯'
      return { id, icon, label, kind, targets, args }
    }

    /**
     * 读设置并迁移旧格式。v1 只有 `{ playlist, index, askEnabled }`（单一 B站 片单），
     * v2 泛化成启动项列表 —— 旧片单成为第一个启动项的内容。
     * @param {unknown} raw - 已解析的 localStorage 内容（或 null）。
     * @returns {typeof DEFAULT_SETTINGS} 归一化后的设置。
     */
    function migrateSettings(raw) {
      if (raw === null || typeof raw !== 'object') return { ...DEFAULT_SETTINGS }
      const askEnabled = raw.askEnabled !== false
      const askText = typeof raw.askText === 'string' && raw.askText.trim() !== ''
        ? raw.askText
        : DEFAULT_SETTINGS.askText
      const pillText = typeof raw.pillText === 'string' && raw.pillText.trim() !== ''
        ? raw.pillText
        : DEFAULT_SETTINGS.pillText

      if (!Array.isArray(raw.entries)) {
        // v1：把旧片单搬进 B站 启动项。
        const playlist = (Array.isArray(raw.playlist) ? raw.playlist : [])
          .filter((item) => typeof item === 'string' && item.trim() !== '')
          .map((item) => item.trim())
        const entries = DEFAULT_SETTINGS.entries.map((entry) =>
          entry.id === 'bilibili' ? { ...entry, targets: playlist } : { ...entry })
        return { ...DEFAULT_SETTINGS, askEnabled, askText, entries }
      }

      const normalized = raw.entries.map(normalizeEntry).filter((entry) => entry !== undefined)
      const entries = normalized.length > 0
        ? normalized
        : DEFAULT_SETTINGS.entries.map((entry) => ({ ...entry }))
      const activeEntryId = entries.some((entry) => entry.id === raw.activeEntryId)
        ? raw.activeEntryId
        : entries[0].id
      const cursors = raw.cursors !== null && typeof raw.cursors === 'object' ? raw.cursors : {}
      const panelWidth = Number.isFinite(raw.panelWidth) && raw.panelWidth >= 280
        ? Math.round(raw.panelWidth)
        : DEFAULT_SETTINGS.panelWidth
      // 只有用户真的拖过才记高度；没拖过就留 undefined 走自动比例。
      const stageHeight = Number.isFinite(raw.stageHeight) && raw.stageHeight >= 120
        ? Math.round(raw.stageHeight)
        : undefined
      const offset = (value, fallback) =>
        (Number.isFinite(value) && value >= 0 && value <= 4000 ? Math.round(value) : fallback)
      const panelRight = offset(raw.panelRight, DEFAULT_SETTINGS.panelRight)
      const panelBottom = offset(raw.panelBottom, DEFAULT_SETTINGS.panelBottom)
      return { version: 2, askEnabled, askText, pillText, entries, activeEntryId, cursors, panelWidth, stageHeight, panelRight, panelBottom }
    }

    function loadSettings() {
      try {
        const stored = window.localStorage.getItem(STORAGE_KEY)
        if (stored === null) return migrateSettings(null)
        return migrateSettings(JSON.parse(stored))
      } catch {
        // 隐私模式或损坏的 JSON 都只是「没有偏好」，不该让浮层挂掉。
        return migrateSettings(null)
      }
    }

    function saveSettings(settings) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
      } catch {
        // 存不下就只影响持久性，本次会话内仍然可用。
      }
    }

    // ── 目标解析 ──────────────────────────────────────────────────────────────

    /** 从一行用户输入里抽出 BV 号：支持裸 BV 号，也支持粘贴整条 B站 链接。 */
    function parseBv(text) {
      if (typeof text !== 'string') return undefined
      const match = /(BV[0-9A-Za-z]{10})/.exec(text.trim())
      return match === null ? undefined : match[1]
    }

    /** 官方播放器嵌入端点：第三方网站就是用它嵌 B站 的（无 X-Frame-Options/CSP）。 */
    function playerUrl(bv) {
      const params = new URLSearchParams({
        bvid: bv,
        page: '1',
        autoplay: '1',
        danmaku: '0',
        high_quality: '1',
        as_wide: '1',
      })
      return `https://player.bilibili.com/player.html?${params.toString()}`
    }

    /**
     * 把一条 embed 目标解析成真正要嵌的地址：BV 号走官方播放器，其余当普通 URL。
     * @param {string} target - 片单里的一行。
     * @returns {string} iframe 的 src。
     */
    function resolveEmbedUrl(target) {
      const bv = parseBv(target)
      return bv === undefined ? target : playerUrl(bv)
    }

    /**
     * 嵌入区默认高度。两个都是**横的**——面板是侧栏，竖比例放网页只能看到一条，
     * 实测用户第一反应就是「9比16显示不全」。
     * 播放器按 16:9（它就是这么设计的），普通网页按 16:10（更像浏览器窗口）。
     */
    function defaultStageHeight(target, width) {
      const isVideoPlayer = typeof target === 'string' && target.includes('player.bilibili.com')
      return Math.round(width * (isVideoPlayer ? 9 / 16 : 10 / 16))
    }

    /** 缩放适配时假装的视口宽度：让被嵌页面以为自己在桌面浏览器里。 */
    const EMBED_VIRTUAL_WIDTH = 1280

    /**
     * 算出被嵌页面的「虚拟视口」与缩放比。
     *
     * **所有嵌入都走缩放**，不按站点区分。原因：面板是侧栏（通常 400–700 宽），
     * 而网页是给桌面宽度设计的。不缩的话 B站 首页在 418px 下布局直接塌掉、卡片点不动
     * （实测）。做法是先按 `max(1280, 面板宽)` 渲染，再整体 CSS 缩放塞进面板 ——
     * 布局完整、横向不会被切；代价是字变小，面板拖宽时缩放比趋近 1，字就恢复。
     *
     * @param {object} input - 计算输入。
     * @param {number} input.innerWidth - 面板内可用宽度（px）。
     * @param {number} input.stageHeight - 可见嵌入区高度（px）。
     * @returns {{ virtualWidth: number, virtualHeight: number, scale: number }} 视口与缩放比。
     */
    function embedViewport({ innerWidth, stageHeight }) {
      const width = Math.max(220, Math.round(innerWidth))
      const height = Math.max(90, Math.round(stageHeight))
      // 只缩不放：面板比虚拟视口还宽时就不放大，避免糊。
      const virtualWidth = Math.max(EMBED_VIRTUAL_WIDTH, width)
      const scale = width / virtualWidth
      const virtualHeight = Math.max(1, Math.round(height / scale))
      return { virtualWidth, virtualHeight, scale }
    }

    /** 面板尺寸的硬边界。 */
    const MIN_PANEL_WIDTH = 300
    const MIN_STAGE_HEIGHT = 120
    /** 拖动时至少留这么多像素在视口里，免得把面板拖到完全看不见。 */
    const MIN_VISIBLE = 140

    /**
     * 一次拖拽之后的几何。纯函数，便于单测。
     *
     * 面板锚在右下角，所以内部用 `{ width, stageHeight, right, bottom }` 表达，
     * `right`/`bottom` 是离视口右边/下边的距离。
     * `handle.dx/dy` 取 -1/0/1：竖直 -1=上边缘、+1=下边缘；水平 -1=左边缘、+1=右边缘；
     * `(0,0)` 表示拖整块（移动）。
     *
     * @param {{width:number,stageHeight:number,right:number,bottom:number}} start - 起始几何。
     * @param {{dx:number,dy:number}} handle - 拖的是哪条边/角。
     * @param {number} deltaX - 指针横向位移（右为正）。
     * @param {number} deltaY - 指针纵向位移（下为正）。
     * @param {{viewportWidth:number,viewportHeight:number}} bounds - 视口尺寸。
     * @returns {{width:number,stageHeight:number,right:number,bottom:number}} 夹紧后的几何。
     */
    function resizePanel(start, handle, deltaX, deltaY, bounds) {
      const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), Math.max(lo, hi))
      const maxWidth = Math.max(MIN_PANEL_WIDTH, bounds.viewportWidth - 16)
      const maxStage = Math.max(MIN_STAGE_HEIGHT, bounds.viewportHeight - 160)
      const maxRight = Math.max(0, bounds.viewportWidth - MIN_VISIBLE)
      const maxBottom = Math.max(0, bounds.viewportHeight - MIN_VISIBLE)

      let { width, stageHeight, right, bottom } = start

      if (handle.dx === 0 && handle.dy === 0) {
        // 移动：整块跟着指针走。
        return {
          width,
          stageHeight,
          right: clamp(right - deltaX, 0, maxRight),
          bottom: clamp(bottom - deltaY, 0, maxBottom),
        }
      }

      if (handle.dy === -1) {
        // 上边缘：往下拖 = 变矮。底边不动，所以只改嵌入区高度。
        stageHeight = clamp(stageHeight - deltaY, MIN_STAGE_HEIGHT, maxStage)
      } else if (handle.dy === 1) {
        // 下边缘：往下拖 = 变高，顶边不动。但底边最多只能移到屏幕下沿 ——
        // 到底了就停住，而不是让面板反向往上长（那样不像其他软件）。
        const wanted = clamp(stageHeight + deltaY, MIN_STAGE_HEIGHT, maxStage)
        const grew = wanted - stageHeight
        const allowed = grew <= 0 ? grew : Math.min(grew, bottom)
        stageHeight += allowed
        bottom -= allowed
      }

      if (handle.dx === -1) {
        // 左边缘：往左拖 = 变宽。右边锚点不动。
        width = clamp(width - deltaX, MIN_PANEL_WIDTH, maxWidth)
      } else if (handle.dx === 1) {
        // 右边缘：往右拖 = 变宽，左边不动。同样，到屏幕右沿就停。
        const wanted = clamp(width + deltaX, MIN_PANEL_WIDTH, maxWidth)
        const grew = wanted - width
        const allowed = grew <= 0 ? grew : Math.min(grew, right)
        width += allowed
        right -= allowed
      }

      return { width, stageHeight, right, bottom }
    }

    /** 八条边/角 + 移动。渲染手柄和拖动都从这张表来。 */
    const RESIZE_HANDLES = [
      { dir: 'n', dx: 0, dy: -1 },
      { dir: 's', dx: 0, dy: 1 },
      { dir: 'w', dx: -1, dy: 0 },
      { dir: 'e', dx: 1, dy: 0 },
      { dir: 'nw', dx: -1, dy: -1 },
      { dir: 'ne', dx: 1, dy: -1 },
      { dir: 'sw', dx: -1, dy: 1 },
      { dir: 'se', dx: 1, dy: 1 },
    ]

    /** 去重 + 保序 + 丢掉认不出来的行（仅用于 B站 片单场景）。 */
    function bvList(playlist) {
      const seen = new Set()
      const out = []
      for (const line of playlist) {
        const bv = parseBv(line)
        if (bv === undefined || seen.has(bv)) continue
        seen.add(bv)
        out.push(bv)
      }
      return out
    }

    /** 该启动项当前应该用第几条目标（越界与负数都折回合法范围）。 */
    function targetOf(entry, cursors) {
      if (entry === undefined || entry === null) return undefined
      const targets = Array.isArray(entry.targets) ? entry.targets : []
      if (targets.length === 0) return undefined
      const raw = cursors === null || cursors === undefined ? 0 : cursors[entry.id]
      const cursor = Number.isInteger(raw) ? raw : 0
      return targets[((cursor % targets.length) + targets.length) % targets.length]
    }

    // ── host 路由调用 ────────────────────────────────────────────────────────

    /**
     * token 是每次 host 启动生成的，所以按页面会话缓存；遇到 403 会重取一次
     * （覆盖 host 重启的情况）。`fetch` 由页面发出，浏览器自动带上
     * `sec-fetch-site: same-origin`，这正是 host 侧要求的那道门。
     */
    let handshake = null

    async function hostHandshake(force = false) {
      if (handshake !== null && !force) return handshake
      const response = await fetch(`${ROUTE_PREFIX}/hello`)
      if (!response.ok) throw new Error(`host 启动器不可用（HTTP ${response.status}）`)
      const payload = await response.json()
      if (payload === null || payload.ok !== true || typeof payload.token !== 'string') {
        throw new Error('host 启动器握手返回异常')
      }
      handshake = payload
      return handshake
    }

    /**
     * 让 host 打开一个 URL/协议，或执行一个程序。
     * @param {'open'|'exec'} action - 动作。
     * @param {string} target - 目标。
     * @param {string[]} [args] - exec 的参数。
     * @param {boolean} [userChosen] - 目标是否由面板里的人显式选定（走「浏览…」或
     *   亲手填的路径）。exec 时带上它，host 才会把这条路径记进本次运行的信任集合。
     */
    async function callHost(action, target, args = [], userChosen = false) {
      const send = (token) => fetch(`${ROUTE_PREFIX}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-bilibili-break-token': token },
        body: JSON.stringify(action === 'exec'
          ? { action, target, args, userChosen }
          : { action, target }),
      })

      const first = await hostHandshake()
      let response = await send(first.token)
      if (response.status === 403) {
        // token 可能因为 host 重启而失效，重取一次再试。也可能是这一条 exec 真的
        // 不在信任集合里 —— 那种情况重试同样会 403，下面照常把原因抛出去。
        const fresh = await hostHandshake(true)
        response = await send(fresh.token)
      }
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload === null || payload.ok !== true) {
        throw new Error(payload !== null && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`)
      }
    }

    /**
     * 让 host 弹一个原生文件选择框，返回选中的绝对路径（取消返回 undefined）。
     *
     * 桌面端能弹出来；网页端浏览器到不了宿主屏幕，host 会回 `{ unsupported: ... }`，
     * 这时由调用方退回手填。中断请求会连带关掉那个对话框 —— host 用 `res.on('close')`
     * 监听，不需要客户端额外发取消信号。
     * @returns {Promise<string | undefined>} 选中的路径。
     */
    async function pickFile(title) {
      const send = (token) => fetch(PICK_FILE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-bilibili-break-token': token },
        body: JSON.stringify({ title }),
      })
      const first = await hostHandshake()
      let response = await send(first.token)
      if (response.status === 403) {
        const fresh = await hostHandshake(true)
        response = await send(fresh.token)
      }
      const payload = await response.json().catch(() => null)
      if (payload === null) throw new Error(`HTTP ${response.status}`)
      if (typeof payload.unsupported === 'string') throw new Error(payload.unsupported)
      if (!response.ok || payload.ok !== true) {
        throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`)
      }
      return typeof payload.path === 'string' && payload.path !== '' ? payload.path : undefined
    }

    // ── 样式 ──────────────────────────────────────────────────────────────────

    /** 颜色尽量走主题变量，跟随深浅色；变量缺失时有兜底值。 */
    const CSS = `
.dbb-layer { position: fixed; inset: 0; pointer-events: none; z-index: 60; }
.dbb-layer > * { pointer-events: auto; }

.dbb-pill, .dbb-card, .dbb-panel, .dbb-notice {
  font-family: inherit;
  color: var(--dsw-alias-label-primary, #1a1a1a);
  background: var(--dsw-alias-bg-elevated, #fff);
  border: 1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.12));
  border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0,0,0,.16);
  box-sizing: border-box;
}

/* 运行中才出现的入口胶囊：不常驻，避免污染界面。 */
.dbb-pill {
  position: fixed; right: 16px; bottom: 16px;
  display: flex; align-items: center; gap: 6px;
  padding: 6px 12px; border-radius: 999px;
  font-size: 12px; line-height: 1; cursor: pointer;
  opacity: .82; transition: opacity .15s ease;
}
.dbb-pill:hover { opacity: 1; }
.dbb-pill-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #fb7299;
  animation: dbb-pulse 1.4s ease-in-out infinite;
}
@keyframes dbb-pulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }

/* 询问 = 启动菜单卡片 */
.dbb-card {
  position: fixed; right: 16px; bottom: 16px;
  width: 340px; padding: 16px;
  display: flex; flex-direction: column; gap: 12px;
}
.dbb-card-title { font-size: 14px; font-weight: 600; line-height: 1.5; }
.dbb-card-sub { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, #888); }
.dbb-card-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.dbb-card-foot { display: flex; justify-content: flex-end; gap: 8px; }

.dbb-btn {
  font: inherit; font-size: 12px; line-height: 1;
  padding: 7px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.12));
  background: transparent; color: inherit;
}
.dbb-btn:hover { background: var(--dsw-alias-bg-hover, rgba(0,0,0,.04)); }
.dbb-btn-primary { background: #fb7299; border-color: #fb7299; color: #fff; }
.dbb-btn-primary:hover { filter: brightness(1.06); background: #fb7299; }

/* 摸鱼面板 */
.dbb-panel {
  position: fixed; right: 16px; bottom: 16px;
  width: 420px; max-width: calc(100vw - 32px);
  /* 顶部给 DSH 自己的窗口控制按钮（右上角那一排，实测底边 y≈38）留安全区。
     不这么做的话，展开编辑器后面板会长到贴着那排按钮，面板头里的 ⚙/✕ 会和
     系统按钮挤在一起（实测间距只剩 6px）。这里留 76px：16 底部 + 约 60 顶部。 */
  max-height: calc(100vh - 76px);
  display: flex; flex-direction: column; overflow: hidden;
}
.dbb-panel-head {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 10px; font-size: 12px;
  border-bottom: 1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.12));
}
/* 标题栏控件太多，留一个明确的抓手，不然没地方拖。 */
.dbb-grip {
  cursor: grab; color: var(--dsw-alias-label-tertiary, #b0b0b0);
  font-size: 13px; line-height: 1; padding: 2px 1px;
  user-select: none; touch-action: none; flex: 0 0 auto;
}
.dbb-grip:hover { color: #fb7299; }
.dbb-grip:active { cursor: grabbing; }
.dbb-panel-status { color: var(--dsw-alias-label-tertiary, #888); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbb-panel-status[data-running='true'] { color: #fb7299; }
.dbb-spacer { flex: 1; }
.dbb-icon {
  font: inherit; font-size: 13px; line-height: 1;
  padding: 4px 7px; border-radius: 6px; cursor: pointer; flex: 0 0 auto;
  border: 1px solid transparent; background: transparent; color: inherit;
  max-width: 160px;
}
.dbb-icon:hover { background: var(--dsw-alias-bg-hover, rgba(0,0,0,.06)); }
/* 高度由内联 style 给（默认按目标类型算：视频 16:9、网页 3:4；用户拖过就用拖的）。
   flex-shrink 允许它在面板触到 max-height 时收缩，免得把编辑器挤出可视区。 */
.dbb-stage { position: relative; overflow: hidden; background: #000; flex: 0 1 auto; min-height: 90px; }
/* 缩放适配层：它按虚拟视口铺开（比如 1280 宽），再由 transform 缩到面板里。 */
.dbb-frame { position: absolute; top: 0; left: 0; transform-origin: top left; }
.dbb-frame iframe { display: block; width: 100%; height: 100%; border: 0; }

/* 八条边/角的缩放手柄。放在面板内侧（面板 overflow:hidden，放外面会被裁掉）。 */
.dbb-resize { position: absolute; z-index: 3; touch-action: none; }
.dbb-resize[data-dir='n']  { top: 0; left: 12px; right: 12px; height: 6px; cursor: ns-resize; }
.dbb-resize[data-dir='s']  { bottom: 0; left: 12px; right: 12px; height: 6px; cursor: ns-resize; }
.dbb-resize[data-dir='w']  { left: 0; top: 12px; bottom: 12px; width: 6px; cursor: ew-resize; }
.dbb-resize[data-dir='e']  { right: 0; top: 12px; bottom: 12px; width: 6px; cursor: ew-resize; }
.dbb-resize[data-dir='nw'] { top: 0; left: 0; width: 12px; height: 12px; cursor: nwse-resize; }
.dbb-resize[data-dir='ne'] { top: 0; right: 0; width: 12px; height: 12px; cursor: nesw-resize; }
.dbb-resize[data-dir='sw'] { bottom: 0; left: 0; width: 12px; height: 12px; cursor: nesw-resize; }
.dbb-resize[data-dir='se'] { bottom: 0; right: 0; width: 12px; height: 12px; cursor: nwse-resize; }
/* 两个下角画个小三角，让人看得出这里能拉。 */
.dbb-resize[data-dir='se']::after,
.dbb-resize[data-dir='sw']::after {
  content: ''; position: absolute; bottom: 3px; width: 7px; height: 7px;
  border-bottom: 2px solid var(--dsw-alias-label-tertiary, #b8b8b8);
}
.dbb-resize[data-dir='se']::after { right: 3px; border-right: 2px solid var(--dsw-alias-label-tertiary, #b8b8b8); }
.dbb-resize[data-dir='sw']::after { left: 3px; border-left: 2px solid var(--dsw-alias-label-tertiary, #b8b8b8); }

.dbb-external {
  padding: 22px 16px; display: flex; flex-direction: column; align-items: center; gap: 10px;
  text-align: center; font-size: 12px; line-height: 1.7;
  color: var(--dsw-alias-label-tertiary, #888);
  background: var(--dsw-alias-bg-secondary, rgba(0,0,0,.02));
}
.dbb-external strong { color: var(--dsw-alias-label-primary, #1a1a1a); font-size: 13px; }

.dbb-empty {
  aspect-ratio: 16 / 9; padding: 20px; box-sizing: border-box;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; text-align: center;
  font-size: 12px; line-height: 1.7;
  color: var(--dsw-alias-label-tertiary, #888);
  background: var(--dsw-alias-bg-secondary, rgba(0,0,0,.02));
}
.dbb-link { color: #fb7299; text-decoration: none; }
.dbb-link:hover { text-decoration: underline; }

/* 启动项编辑器 */
.dbb-config {
  padding: 10px; display: flex; flex-direction: column; gap: 10px;
  font-size: 12px; overflow-y: auto;
}
.dbb-config textarea, .dbb-config input[type='text'], .dbb-entry select {
  font: inherit; font-size: 12px; box-sizing: border-box;
  padding: 7px 8px; border-radius: 8px; color: inherit; background: transparent;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.12));
}
.dbb-config input[type='text'] { width: 100%; }
.dbb-config textarea { width: 100%; min-height: 54px; resize: vertical; }
.dbb-config-row { display: flex; align-items: flex-start; gap: 8px; line-height: 1.6; }
.dbb-size-row { flex-wrap: wrap; align-items: center; }
.dbb-size-row .dbb-btn { padding: 6px 10px; }
.dbb-config-hint { color: var(--dsw-alias-label-tertiary, #888); line-height: 1.6; }
.dbb-entry {
  border: 1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.12));
  border-radius: 10px; padding: 9px; display: flex; flex-direction: column; gap: 7px;
}
.dbb-entry[data-active='true'] { border-color: #fb7299; }
.dbb-entry-head { display: flex; align-items: center; gap: 6px; }
.dbb-entry-head input[type='text'] { flex: 1; min-width: 0; }
.dbb-entry-icon { width: 44px; flex: 0 0 auto; text-align: center; }
/* 路径输入框：等宽字体更容易核对，长路径横向滚动而不是撑破面板。 */
.dbb-entry-path { font-family: ui-monospace, Consolas, monospace; font-size: 11px; }
.dbb-btn:disabled { opacity: .55; cursor: default; }

/* 轻量提示：tab/host/exec 这类没有面板可展示的动作要回馈结果 */
.dbb-notice {
  position: fixed; right: 16px; bottom: 16px;
  max-width: 340px; padding: 10px 14px; font-size: 12px; line-height: 1.6;
}
.dbb-notice[data-kind='error'] { color: #d4380d; border-color: rgba(212,56,13,.4); }
`

    // ── 浮层组件 ──────────────────────────────────────────────────────────────

    /** props.useSessions 缺失时的占位，保证 hook 调用顺序恒定。 */
    const noSessions = () => undefined

    function Layer(props) {
      const useSessions = props !== null && typeof props?.useSessions === 'function'
        ? props.useSessions
        : noSessions

      // 运行位来自会话列表快照。注意别只认 `current`：在「新会话」视图下
      // `SessionListState.current` 是 undefined，而 turn 已经在跑了——只认
      // current 的话这里会永远短路成 false，弹窗一次都不会出现（已实测）。
      // 所以 current 落位时优先用它，否则退回「列表里有任何会话在跑」。
      const running = useSessions((state) => {
        if (state === undefined || state === null) return false
        const byId = state.byId
        if (byId === undefined) return false
        const current = state.current
        if (current !== undefined) {
          const summary = byId[current]
          if (summary !== undefined) return summary.running === true
        }
        for (const key in byId) {
          if (byId[key] !== undefined && byId[key].running === true) return true
        }
        return false
      })

      const [settings, setSettings] = React.useState(loadSettings)
      const [asking, setAsking] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const [showConfig, setShowConfig] = React.useState(false)
      /** 拖拽缩放中的实时尺寸（null = 用持久化值）。放手才写 localStorage。 */
      const [liveSize, setLiveSize] = React.useState(null)
      const liveSizeRef = React.useRef(null)
      const [notice, setNotice] = React.useState(null)
      /** 这一轮已经问过并被拒绝了：同一个 run 内不再骚扰。 */
      const declinedRunRef = React.useRef(false)
      const noticeTimerRef = React.useRef(undefined)

      const update = React.useCallback((next) => {
        setSettings((prev) => {
          const merged = { ...prev, ...next }
          saveSettings(merged)
          return merged
        })
      }, [])

      const flash = React.useCallback((kind, text) => {
        setNotice({ kind, text })
        if (noticeTimerRef.current !== undefined) window.clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = window.setTimeout(() => setNotice(null), 4500)
      }, [])

      React.useEffect(() => () => {
        if (noticeTimerRef.current !== undefined) window.clearTimeout(noticeTimerRef.current)
      }, [])

      // 运行态变化：回到 idle 就解除「本轮已拒绝」，下一轮可以重新询问。
      React.useEffect(() => {
        if (running) return
        declinedRunRef.current = false
        setAsking(false)
      }, [running])

      // 核心时机：agent 忙过 ASK_DELAY_MS 之后仍在跑，才弹询问。
      React.useEffect(() => {
        if (!running || !settings.askEnabled || declinedRunRef.current || open) return
        const id = window.setTimeout(() => setAsking(true), ASK_DELAY_MS)
        return () => window.clearTimeout(id)
      }, [running, settings.askEnabled, open, settings.entries.length])

      // 手动控制：任何时候都能用快捷键开关面板。
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.ctrlKey && event.shiftKey && (event.key === 'B' || event.key === 'b')) {
            event.preventDefault()
            setOpen((prev) => !prev)
            setAsking(false)
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [])

      const entries = settings.entries
      const activeEntry = entries.find((entry) => entry.id === settings.activeEntryId) ?? entries[0]

      /** 按启动项的类型把动作落到该去的地方。 */
      const launchEntry = async (entry) => {
        const target = targetOf(entry, settings.cursors)
        setAsking(false)
        update({ activeEntryId: entry.id })

        if (entry.kind === 'embed') {
          setOpen(true)
          return
        }
        if (target === undefined) {
          flash('error', `「${entry.label}」还没配置目标地址`)
          return
        }
        try {
          if (entry.kind === 'tab') {
            // 刻意不用 features 里的 `noopener`：按规范只要带它，window.open 就
            // 必定返回 null，于是「被拦截」的检测会永远误报。改成拿到引用后手动
            // 切断 opener —— 既保住返回值，安全性也一样。
            const opened = window.open(target, '_blank')
            if (opened !== null) {
              try { opened.opener = null } catch { /* 跨源时可能被拒，忽略 */ }
            }
            flash(opened === null ? 'error' : 'ok',
              opened === null ? '浏览器拦截了新标签页，请允许后重试' : `已在新标签页打开「${entry.label}」`)
            return
          }
          const exec = isExecKind(entry.kind)
          // userChosen：面板里的人显式选的程序（浏览…/亲手粘路径），host 才信任。
          await callHost(exec ? 'exec' : 'open', target, entry.args, exec)
          flash('ok', exec ? `已启动「${entry.label}」` : `已交给系统打开「${entry.label}」`)
        } catch (error) {
          flash('error', `${entry.label}：${String(error?.message ?? error)}`)
        }
      }

      const cycle = (delta) => {
        if (activeEntry === undefined || activeEntry.targets.length < 2) return
        const index = activeEntry.targets.indexOf(targetOf(activeEntry, settings.cursors))
        const count = activeEntry.targets.length
        const next = (((index < 0 ? 0 : index) + delta) % count + count) % count
        update({ cursors: { ...settings.cursors, [activeEntry.id]: next } })
      }

      const children = []

      if (running && !open && !asking && notice === null) {
        children.push(h('button', {
          key: 'pill',
          type: 'button',
          className: 'dbb-pill',
          title: '摸鱼（Ctrl+Shift+B）',
          onClick: () => setOpen(true),
        }, h('span', { className: 'dbb-pill-dot' }), settings.pillText))
      }

      if (asking && !open) {
        children.push(h('div', { key: 'card', className: 'dbb-card', role: 'dialog' },
          h('div', { className: 'dbb-card-title' }, settings.askText),
          h('div', { className: 'dbb-card-sub' }, '挑一个，或者继续干活。'),
          h('div', { className: 'dbb-card-actions' },
            ...entries.map((entry) => h('button', {
              key: entry.id,
              type: 'button',
              className: 'dbb-btn dbb-btn-primary',
              onClick: () => { void launchEntry(entry) },
            }, `${entry.icon} ${entry.label}`)),
          ),
          h('div', { className: 'dbb-card-foot' },
            // 编辑器藏在面板的 ⚙ 后面，不显眼——实测有人整轮都没发现「可以自定义」。
            // 所以在卡片上直接给一个入口：点了就开面板并展开编辑器。
            h('button', {
              type: 'button',
              className: 'dbb-btn',
              title: '添加你自己的启动项（Steam、本地游戏等）',
              onClick: () => {
                declinedRunRef.current = true
                setAsking(false)
                setOpen(true)
                setShowConfig(true)
              },
            }, '＋ 自定义…'),
            h('button', {
              type: 'button',
              className: 'dbb-btn',
              onClick: () => {
                declinedRunRef.current = true
                setAsking(false)
              },
            }, '不用了'),
          ),
        ))
      }

      if (open && activeEntry !== undefined) {
        const target = targetOf(activeEntry, settings.cursors)
        const isEmbed = activeEntry.kind === 'embed'

        // 拖拽中用 liveSize（每帧渲染但不写盘），松手时才落一次 localStorage。
        const resolvedUrl = target === undefined ? undefined : resolveEmbedUrl(target)
        const geometry = liveSize ?? {
          width: settings.panelWidth,
          // 注意传的是**解析后**的地址：raw target 可能只是个 BV 号，拿它判断
          // 「是不是播放器」永远不成立（这个 bug 是量尺寸时发现的）。
          stageHeight: settings.stageHeight ?? defaultStageHeight(resolvedUrl, settings.panelWidth),
          right: settings.panelRight,
          bottom: settings.panelBottom,
        }
        const panelWidth = geometry.width
        const stageHeight = geometry.stageHeight

        /**
         * 统一的拖拽：八条边/角调尺寸，`{dx:0,dy:0}` 是拖标题栏移动。
         * 每帧只更新内存里的实时几何，松手才写一次 localStorage。
         */
        const startDrag = (event, handle) => {
          if (event.button !== undefined && event.button !== 0) return
          event.preventDefault()
          const start = { ...geometry }
          const startX = event.clientX
          const startY = event.clientY
          const bounds = { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }
          const move = (moveEvent) => {
            const next = resizePanel(
              start, handle,
              moveEvent.clientX - startX, moveEvent.clientY - startY,
              bounds,
            )
            liveSizeRef.current = next
            setLiveSize(next)
          }
          const finish = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', finish)
            const final = liveSizeRef.current
            liveSizeRef.current = null
            setLiveSize(null)
            if (final !== null) {
              update({
                panelWidth: final.width,
                stageHeight: final.stageHeight,
                panelRight: final.right,
                panelBottom: final.bottom,
              })
            }
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', finish)
        }

        let stage
        if (!isEmbed) {
          stage = h('div', { className: 'dbb-external', style: { height: `${stageHeight}px`, boxSizing: 'border-box' } },
            h('strong', null, `${activeEntry.icon} ${activeEntry.label}`),
            h('div', null, `这一类是「${KIND_LABEL[activeEntry.kind] ?? activeEntry.kind}」，没有可嵌的内容。`),
            h('button', {
              type: 'button',
              className: 'dbb-btn dbb-btn-primary',
              onClick: () => { void launchEntry(activeEntry) },
              // 这个按钮就是启动动作本身。exec 一族显示「启动软件」（和类型名一致，
              // 比「再来一次」更像按钮该说的话）；tab/host 的语义是"再打开一个"，
              // 保留原文案。
            }, isExecKind(activeEntry.kind) ? '启动软件' : '再来一次'),
          )
        } else if (target === undefined) {
          stage = h('div', { className: 'dbb-empty', style: { height: `${stageHeight}px`, boxSizing: 'border-box' } },
            h('div', null, '这个启动项还没有目标地址，贴几个 BV 号或链接就能在这儿播。'),
            h('a', { className: 'dbb-link', href: 'https://www.bilibili.com', target: '_blank', rel: 'noreferrer' }, '先去 B站 逛逛 →'),
            h('button', { type: 'button', className: 'dbb-btn', onClick: () => setShowConfig(true) }, '编辑启动项'),
          )
        } else {
          // 所有嵌入都先按桌面视口渲染再整体缩放：布局完整、横向不会被切。
          const viewport = embedViewport({ innerWidth: panelWidth - 2, stageHeight })
          stage = h('div', { key: target, className: 'dbb-stage', style: { height: `${stageHeight}px` } },
            h('div', {
              className: 'dbb-frame',
              'data-scale': viewport.scale.toFixed(4),
              style: {
                width: `${viewport.virtualWidth}px`,
                height: `${viewport.virtualHeight}px`,
                transform: `scale(${viewport.scale})`,
              },
            },
            h('iframe', {
              src: resolvedUrl,
              title: `${activeEntry.label} 内容`,
              allowFullScreen: true,
              allow: 'autoplay; fullscreen; encrypted-media',
              referrerPolicy: 'no-referrer-when-downgrade',
              // 关键：**不授权 allow-top-navigation** —— 那是唯一能把整个 DSH 界面
              // 顶掉的能力，实测 B站 播放器点一下就会这么干。
              //
              // 其余按「正常浏览网页」给：allow-popups 让 target=_blank 的链接能开
              // 新标签页而不是静默失效；allow-forms/presentation 是常规能力。
              // 仍然不给 allow-modals（阻塞式对话框很烦）。
              sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation',
            }),
            ),
          )
        }

        const controls = []
        if (isEmbed && activeEntry.targets.length > 1) {
          controls.push(
            h('button', { key: 'prev', type: 'button', className: 'dbb-icon', title: '上一个', onClick: () => cycle(-1) }, '⏮'),
            h('button', { key: 'next', type: 'button', className: 'dbb-icon', title: '下一个', onClick: () => cycle(1) }, '⏭'),
            h('button', {
              key: 'shuffle', type: 'button', className: 'dbb-icon', title: '随机',
              onClick: () => update({
                cursors: {
                  ...settings.cursors,
                  [activeEntry.id]: Math.floor(Math.random() * activeEntry.targets.length),
                },
              }),
            }, '🔀'),
          )
        }

        children.push(h('div', {
          key: 'panel',
          className: 'dbb-panel',
          style: {
            width: `${panelWidth}px`,
            right: `${geometry.right}px`,
            bottom: `${geometry.bottom}px`,
          },
        },
          h('div', {
            className: 'dbb-panel-head',
            title: '拖动这里移动面板',
            onPointerDown: (event) => {
              // 点在按钮/下拉上时不该触发移动。
              if (event.target.closest('button, select, input, textarea, a') !== null) return
              startDrag(event, { dx: 0, dy: 0 })
            },
          },
          // 标题栏几乎被控件占满，没剩多少空白可抓 —— 给一个明确的抓手。
          h('span', {
            className: 'dbb-grip',
            title: '拖动移动面板',
            onPointerDown: (event) => startDrag(event, { dx: 0, dy: 0 }),
          }, '⠿'),
            h('select', {
              className: 'dbb-icon',
              value: activeEntry.id,
              title: '切换启动项',
              onChange: (event) => {
                const picked = entries.find((entry) => entry.id === event.target.value)
                if (picked !== undefined) {
                  update({ activeEntryId: picked.id })
                  setShowConfig(false)
                }
              },
            }, ...entries.map((entry) => h('option', { key: entry.id, value: entry.id }, `${entry.icon} ${entry.label}`))),
            h('span', { className: 'dbb-panel-status', 'data-running': running ? 'true' : 'false' },
              running ? 'AI 正在工作…' : 'AI 干完了'),
            h('span', { className: 'dbb-spacer' }),
            ...controls,
            h('button', {
              key: 'cfg', type: 'button', className: 'dbb-icon',
              title: showConfig ? '收起设置' : '启动项与设置',
              onClick: () => setShowConfig((prev) => !prev),
            }, '⚙'),
            h('button', {
              key: 'close', type: 'button', className: 'dbb-icon', title: '收起（Ctrl+Shift+B）',
              onClick: () => setOpen(false),
            }, '✕'),
          ),
          stage,
          showConfig ? renderConfig(settings, update, activeEntry) : null,
          // 八条边/角的缩放手柄（面板锚在右下角，所以往左/往上拖是放大）。
          ...RESIZE_HANDLES.map((handle) => h('div', {
            key: `resize-${handle.dir}`,
            className: 'dbb-resize',
            'data-dir': handle.dir,
            title: '拖动调整大小',
            onPointerDown: (event) => startDrag(event, handle),
          })),
        ))
      }

      if (notice !== null) {
        children.push(h('div', { key: 'notice', className: 'dbb-notice', 'data-kind': notice.kind }, notice.text))
      }

      return h('div', { className: 'dbb-layer' }, ...children)
    }

    /** 设置与启动项编辑器。独立函数，避免把 Layer 的主体撑得更长。 */
    function renderConfig(settings, update, activeEntry) {
      const patchEntry = (id, patch) => {
        update({ entries: settings.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) })
      }

      const addEntry = () => {
        const id = `entry-${Math.random().toString(36).slice(2, 8)}`
        update({
          entries: [...settings.entries, { id, icon: '🎯', label: '新启动项', kind: 'embed', targets: [], args: [] }],
          activeEntryId: id,
        })
      }

      const removeEntry = (id) => {
        const rest = settings.entries.filter((entry) => entry.id !== id)
        const entries = rest.length > 0
          ? rest
          : [{ id: 'blank', icon: '🎯', label: '新启动项', kind: 'embed', targets: [], args: [] }]
        update({
          entries,
          activeEntryId: entries.some((entry) => entry.id === settings.activeEntryId)
            ? settings.activeEntryId
            : entries[0].id,
        })
      }

      const linesOf = (value) => value.split('\n').map((line) => line.trim()).filter((line) => line !== '')

      return h('div', { className: 'dbb-config' },
        // 文案（askText / pillText）仍然是持久化字段，但不再在设置页暴露编辑框：
        // 这两句话是产品语气的一部分，改动会破坏一致性，所以只保留常量取值。
        h('label', { className: 'dbb-config-row' },
          h('input', {
            type: 'checkbox',
            checked: settings.askEnabled,
            onChange: (event) => update({ askEnabled: event.target.checked }),
          }),
          h('span', null, 'AI 忙过 10 秒后自动询问（Ctrl+Shift+B 随时开关面板）'),
        ),
        h('div', { className: 'dbb-config-hint' }, '面板大小'),
        // 预设按钮：拖拽手柄只有 8px，太隐蔽；给一排点一下就换的尺寸。
        // 选预设会清掉手动拖过的高度，回到该宽度的自动横比例。
        h('div', { className: 'dbb-config-row dbb-size-row' },
          ...SIZE_PRESETS.map((preset) => h('button', {
            key: preset.label,
            type: 'button',
            className: `dbb-btn${Math.round(settings.panelWidth) === preset.width ? ' dbb-btn-primary' : ''}`,
            title: `面板宽 ${preset.width}px${preset.hint === undefined ? '' : `（${preset.hint}）`}`,
            onClick: () => update({ panelWidth: preset.width, stageHeight: undefined }),
          }, preset.label)),
          h('button', {
            type: 'button',
            className: 'dbb-btn',
            title: '回到默认宽度与自动横比例',
            onClick: () => update({
              panelWidth: DEFAULT_SETTINGS.panelWidth,
              stageHeight: undefined,
            }),
          }, '重置'),
        ),
        h('div', { className: 'dbb-config-hint' },
          `当前 ${Math.round(settings.panelWidth)}×`
          + `${settings.stageHeight === undefined ? '自动（横比例）' : Math.round(settings.stageHeight)}`
          + '　·　也可以直接拖面板左下角，拖宽了字会更大'),
        h('div', { className: 'dbb-config-hint' }, '启动项'),
        ...settings.entries.map((entry) => h('div', {
          key: entry.id,
          className: 'dbb-entry',
          'data-active': activeEntry !== undefined && entry.id === activeEntry.id ? 'true' : 'false',
        },
        h('div', { className: 'dbb-entry-head' },
          h('input', {
            type: 'text', className: 'dbb-entry-icon', value: entry.icon, maxLength: 4, title: '图标',
            onChange: (event) => patchEntry(entry.id, { icon: event.target.value }),
          }),
          h('input', {
            type: 'text', value: entry.label, title: '名称',
            onChange: (event) => patchEntry(entry.id, { label: event.target.value }),
          }),
          h('button', { type: 'button', className: 'dbb-icon', title: '删除', onClick: () => removeEntry(entry.id) }, '🗑'),
        ),
        h('div', { className: 'dbb-entry-head' },
          h('select', {
            value: entry.kind,
            title: '启动方式',
            onChange: (event) => patchEntry(entry.id, { kind: event.target.value }),
          }, ...ENTRY_KINDS.map((kind) => h('option', { key: kind, value: kind }, KIND_LABEL[kind]))),
        ),
        h('div', { className: 'dbb-config-hint' }, KIND_HINT[entry.kind]),
        entry.kind === 'exe'
          // exe 用单行输入框而不是 textarea：它只取第一行，多行会让人以为能填多个。
          ? h('div', { className: 'dbb-entry-head' },
              h('input', {
                type: 'text',
                className: 'dbb-entry-path',
                value: entry.targets[0] ?? '',
                spellCheck: false,
                placeholder: 'C:\\Program Files\\Foo\\foo.exe',
                title: '可执行文件路径',
                onChange: (event) => patchEntry(entry.id, {
                  targets: event.target.value.trim() === '' ? [] : [event.target.value.trim()],
                }),
              }),
              h('button', {
                type: 'button',
                className: 'dbb-btn',
                title: '打开系统文件选择框',
                onClick: (event) => {
                  const button = event.currentTarget
                  button.disabled = true
                  pickFile(`选择要启动的程序（${entry.label}）`)
                    .then((path) => {
                      if (path !== undefined) patchEntry(entry.id, { targets: [path] })
                    })
                    .catch((error) => {
                      flash('error', `打不开文件选择框：${String(error?.message ?? error)}。可以直接粘路径。`)
                    })
                    .finally(() => { button.disabled = false })
                },
              }, '浏览…'),
            )
          : h('textarea', {
              value: entry.targets.join('\n'),
              spellCheck: false,
              placeholder: entry.kind === 'embed'
                ? 'BV1xxxxxxxxx\nhttps://www.bilibili.com/video/BV1yyyyyyyyy'
                : 'steam://run/730',
              onChange: (event) => patchEntry(entry.id, { targets: linesOf(event.target.value) }),
            }),
        isExecKind(entry.kind)
          ? h('div', { className: 'dbb-config-hint' }, '参数（每行一个）。')
          : null,
        isExecKind(entry.kind)
          ? h('textarea', {
              value: entry.args.join('\n'),
              spellCheck: false,
              placeholder: '--fullscreen',
              onChange: (event) => patchEntry(entry.id, { args: linesOf(event.target.value) }),
            })
          : null,
        entry.kind === 'exec'
          ? h('div', { className: 'dbb-config-hint' }, '注意：这一条按「自动」对待，host 侧 allowExec 关闭或 allowlist 不含它会拒绝。要省事就用上面的「启动软件」。')
          : null,
        )),
        h('button', { type: 'button', className: 'dbb-btn', onClick: addEntry }, '+ 添加启动项'),
      )
    }

    // ── 插件 ──────────────────────────────────────────────────────────────────

    function installStyles() {
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = `${PLUGIN_ID}/client`
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /**
     * 挂载客户端半个插件。
     * @param ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      ctx.effect(installStyles, 'bilibili-break: overlay styles')

      // shell.overlay 由 ui-layout 声明；slots.inject 会等声明出现再注册，
      // 所以插件比 ui-layout 先装载也不会丢贡献。
      ctx.effect(
        () => slots.inject('shell.overlay', () => slots.register(
          { name: 'shell.overlay', id: ENTRY_ID },
          Layer,
        )),
        'bilibili-break: overlay entry',
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    /**
     * 纯函数出口，仅供测试直接断言解析/建模逻辑；不属于插件 API。
     * （vision-router 也这样导出手写 bundle 里的内部工具函数。）
     */
    exports.__test = {
      DEFAULT_SETTINGS,
      ENTRY_KINDS,
      KIND_LABEL,
      KIND_HINT,
      EXEC_KINDS,
      isExecKind,
      PICK_FILE_ROUTE,
      ROUTE_PREFIX,
      bvList,
      loadSettings,
      migrateSettings,
      normalizeEntry,
      parseBv,
      playerUrl,
      resolveEmbedUrl,
      defaultStageHeight,
      embedViewport,
      resizePanel,
      targetOf,
    }
    return module.exports
  },
})
