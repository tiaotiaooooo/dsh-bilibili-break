# dsh-摸鱼插件

> agent 在忙的时候，在界面里问你一句「AI 正在工作，来摸一会鱼吧~」，而不是擅自弹你一脸标签页。

DSH（DeepSeek Harness）摸鱼插件，**桌面端和网页端通用**（桌面端的界面就是同一套 Web GUI 套在 Electron 里）。

它不只是「打开摸鱼站」——你可以自己定义一排**摸鱼方式**，点什么开什么。

## 它怎么工作

```
agent 开始干活
      │
      ├─ 10 秒内就干完了 ──► 什么都不发生
      │
      └─ 10 秒后还在跑
              │
              ▼
        右下角弹出：你自定义的文案 + 每个启动项一个按钮
              │
       ┌──────┴───────────────┬──────────────┬──────────┐
       ▼                      ▼              ▼          ▼
   🎬 摸鱼站            🌐 摸鱼 首页     🕹 某个网页游戏   😴 不用了
   打开（内置浏览器小窗）   打开（新标签页）     打开（内置浏览器小窗）    本轮不再打扰
   （不抢焦点）                                          
```

**为什么先问再做**：直接开标签页会抢焦点、把你从 DSH 里踢出去——而"看不见 agent"恰恰是你不敢放心摸鱼的原因。先问一句，你点头才开，不点头什么都不发生。

面板头上会显示 `AI 正在工作…` / `AI 干完了`，所以你不会陷在视频里漏掉 agent 收工。

## 自定义启动

五类启动方式，风险量级完全不同，所以分开：

| 类型 | 行为 | 谁执行 | 适合 |
| --- | --- | --- | --- |
| `embed` | 打开 DSH **内置浏览器**（右侧栏 `browser` 标签），面板做指路牌，**不抢焦点** | 浏览器 | 允许 iframe 的站点（B站 官方播放器就是）。目标可以写多行，就是播放列表，支持切歌/随机 |
| `tab` | 新标签页打开 | 浏览器 | 不允许 iframe 的网站 |
| `host` | 交给 host 用**系统默认处理程序**打开 URL/协议 | host | `steam://run/730`、`spotify:`、`mailto:` —— 和打开网页同一量级 |
| `exe` | **点「浏览…」用系统文件选择框挑一个程序**，或直接粘路径 | host | 打开本机软件。日常用这个 |
| `exec` | 交给 host 真正 spawn 可执行文件 + 参数（不带选择框） | host | 给懂配置的人一个原样入口。按「自动」对待，受 allowlist 严格约束 |

`exe` 与 `exec` 在 host 侧是**同一个动作**（都走 `exec`），区别只在编辑体验：`exe` 有「浏览…」按钮，且免受 `execAllowlist` 的静态名单约束（见下面的安全模型）。

**配置在面板里改**：`Ctrl+Shift+B` 开面板 → ⚙ → 自动询问开关、面板尺寸、启动项的增删改（图标/名称/类型/目标/参数）。存在 `localStorage`。

> 为什么配置在浏览器侧而不是 host 配置里：**客户端插件读不到 host 插件的 `config`**。而启动项本来就是浏览器侧的个人偏好，放 `localStorage` 反而让桌面端和网页端共享同一套行为。代价是换端口/清缓存会丢。

`embed` 的目标里，**BV 号会自动换成视频站点的官方播放器地址**，普通 URL 原样使用：

```
BV1GJ411x7h7                                          → player.example.com/player.html?bvid=BV1GJ411x7h7&...
https://www.example.com/video/BV1xx411c7mD           → 同上（自动抽出 BV 号）
https://example.test/game                             → 原样嵌入
```

## 安全模型（`host` / `exe` / `exec` 三类必读）

浏览器里的代码不能打开本地程序，所以后三类要回 host 执行：host 注册三条同源路由，客户端 `fetch` 过去。

```
GET  /_dsh/moyu-break/hello      握手：拿本次启动的 token 与能力位
POST /_dsh/moyu-break/launch     执行：{ action: 'open'|'exec', target, args?, userChosen? }
POST /_dsh/moyu-break/pick-file  弹系统文件选择框：{ title? } -> { path } 或 { path: null }（取消）
```

三道门，缺一不可：

1. **方法固定**（`hello` 只 GET，其余只 POST）—— 顺带掐掉跨站表单提交；
2. **`checkRequestFence`**（对齐 DSH 自家 `/api` 的信任模型 `api-request-trust.ts`）：
   - **`Host` 必须存在且是环回**（`127.x` / `localhost` / `[::1]`）—— 这是防 **DNS rebinding** 的**主门**。rebind 后 `sec-fetch-site` 会是 `same-origin`、`Origin` 也会匹配，只有 Host 还是攻击者域名，所以 Host 必须绑死。非环回访问（局域网部署）可用 `launcherTrustedHosts` 显式信任；
   - **`sec-fetch-site` 显式是 `cross-site` → 403** —— 这是防 **CSRF** 的主门，别的网页发起的 fetch 必然被浏览器标成 cross-site；
   - **有标记时 `Origin` 必须等于 `Host`** → 否则 403（含字面量 `null` 的不透明源）；头缺失（curl、Electron 非标准窗口）时跳过，靠 Host 环回 + token 兜底。
3. **每次启动生成的随机 token**，走 `x-dsh-moyu-break-token` 头 —— 纵深防御。**这条只加在 POST 路由上**：`hello` 本身是 token 的来源，要求它先带 token 是死循环。

> **这段闸门的形状是用一次真实事故换来的。** 旧版要求「`sec-fetch-site` 必须**存在**且必须是 `same-origin`」，本意是比框架更严——结果桌面端 Electron 窗口对本机服务的 fetch 并不带这个头，`/hello` 握手全程 403，「浏览…」和启动全挂，而客户端只报得上一句 `HTTP 403`，服务端收到了什么头完全无从得知。教训：**别在框架已有一套久经验模型的地方另起炉灶；诊断工具（见 `fenceProbe`）要在出事前就位。**

再往下一层的分权：

- `open` 只接受**带 scheme 的 URL**，且明确拒绝 `file:` / `data:` / `javascript:` / `vbscript:` / `blob:`。本地文件不走这条路。
- `exec` 需要配置里显式打开 `allowExec`（**默认 false**）。spawn 一律 `shell: false`，参数不会被二次解析。
- `execAllowlist` 收窄到具体可执行文件（支持全路径或基名）。**名字听起来像"基名/后缀匹配"其实不是**：比较是先归一化（斜杠方向、大小写、尾随分隔符），再要求**完全相等**、或者以 `\<名字>` / `/<名字>` 结尾。所以 `foo.exe` 能匹配 `C:\any\foo.exe`，但匹配不上 `myfoo.exe`。

```yaml
# 想启用 exec / exe，在 profile 补丁里显式打开：
- id: moyu-break
  name: dsh-moyu-break
  config:
    allowExec: true
    execAllowlist: ['code.exe']     # 留空表示不进一步收窄（放行任意可执行文件）
    trustPanelPickedExec: true      # 默认 true，见下
```

### 面板选定的路径：`trustPanelPickedExec`

`exe` 类要让用户"选个软件就能用"，所以除了静态的 `execAllowlist`，还有一层**运行时信任集合**：

- 请求带 `userChosen: true`（面板只在自己收到过用户动作时才带：点了「浏览…」选中，或亲手粘了路径）→ 这条路径被记进**内存里**的信任集合，本次运行内一直放行；
- 之后同一路径再触发（比如启动项被重复点）不需要再带 `userChosen`；
- 集合**只活在内存**，DSH 重启即清空 —— 持久化会让"哪天被写进去的路径"变成看不见的后门；
- 每次新记一条都会打一条 `info` 日志，出问题时能看出是哪次操作放进来的；
- 把 `trustPanelPickedExec` 设成 `false` 就回到"必须手写进 `execAllowlist`"的严格模式。

> **这是一次显式的取舍。** 它把安全边界从"部署者写的静态名单"放宽到"面板即信任"。理由是面板本来就在同一个信任域里（它已经能调 `allowOpen` 让 host 打开任意协议），而"用户在自己界面里点浏览选了个 exe"和"在配置文件里写一行"意图强度是一样的。代价是：能拿到面板同源 token 的代码，也能让 host 执行它选的程序。不想要这个代价就把开关关掉。

### 原生文件选择框

`exe` 的「浏览…」按钮背后是一条真实的 Windows `IFileOpenDialog`（`koffi` 调 COM），**不是** `<input type="file">` —— 浏览器出于安全只给 `C:\fakepath\...`，拿不到真路径。

- 对话框跑在**子进程**里：`Show` 是阻塞的模态循环，放主线程会把整个 DSH 卡住；子进程的对话框是它自己的第一个窗口，Windows 会自动带到前台；
- **worker 用 DSH 自带的独立 Node 起，不用 `process.execPath`** —— 桌面端 host 跑在 Electron 的 Node 里，koffi 二进制与 Electron 的 N-API 不兼容：worker 正常弹框、用户正常点「打开」，紧接着在 `koffi.view()`（读所选路径）处**原生崩溃（SIGABRT/134）**，表现就是"对话框关了但地址没回填"。`resolveNodeBinary` 在 Electron 宿主下从 `$DSH_HOME/dsh-runtimes/*/dependencies/node/bin/node` 选独立 Node（`DSH_PICKER_NODE` 可覆盖），非 Electron 宿主保持 `process.execPath`；
- 驱动端等 `close` 而非 `exit` 才判失败：worker 发完 `done` 立刻退出，`exit` 会抢在 IPC 消息投递前到，把成功误判成失败；
- 客户端断开（关页面/关面板）会 abort 请求，host 借 `res.on('close')` 杀掉 worker，对话框不会孤零零留在屏幕上；
- 需要 `koffi`（DSH profile 里本来就有）。探不到时会话里的 `pickable` 能力位为 `false`、路由回 501，**面板会退回成手填路径**，不会留下一个按了没反应的按钮；
- 目前只实现了 win32。macOS / Linux 会走上面同一条"退回手填"的路。

## 方案 A（已搁置）：桌面端 `<webview>` 真浏览器内嵌

> **状态：已从产品代码剥离**（代码在 git `c3327af`，探针在 `tests-archive/electron-webview-probe/`）。动机：iframe + sandbox 下 **B站 点视频必然弹新标签页**（跨源 iframe 改不了别人的 `target="_blank"`）。方案是桌面端换 `<webview>` 真浏览器内核 + 注入锚点改写（`_blank`→`_self` + MutationObserver，弹窗阻断）。**独立 Electron 探针全链路通过**——加载、注入、缩放坐标点击命中、视频真播（readyState 4）、popup BLOCKED——但放进**真实 DSH 窗口后黑屏不可用**：探针是裸 BrowserWindow，而真实应用的 `will-attach-webview` 拦截、webviewTag 实际开关这类**应用层策略探针结构上测不到**（坑 #11），外加 `display:block` 冻结 guest 视口 150px 的怪癖（坑 #10）。当前产品恒为 iframe；网页面原地看视频的办法：`embed` 目标填 BV 号走官方播放器。重新尝试的前提：CDP 连真实 DSH 窗口诊断应用层拦截。

## 方案 B：驱动 DSH 内置浏览器（当前主线，真实环境 7/7 验证）

A 搁置后改走 B：**网页不自己嵌，直接开 DSH 自己的内置浏览器**（右侧栏 `browser` 标签），面板转身做三件事——**AI 工作时间 / 结果 / 有无问题** 的状态显示，外加把内置浏览器优化成**右下角小窗**。

### 打开链路

API 形状从 DSH 自家调用点（`dsh-client-ui-settings-account` 的 `openExternalLink`，明文）抄的：

```js
ctx.get('sidebarRight')?.openTab('browser', { params: { url } })   // 打开/导航内置浏览器
ctx.get('sidebarRightTabs')?.get('browser') !== undefined          // 能力探测
```

- **必须走 `ctx.get()`**：直接 `ctx.sidebarRight` 会触发 cordis inject 门
  （`cannot get property "sidebarRight" without inject`）——踩过一次（坑 #12）。
- **分流（按用户定的规则）**：`embed` 启动项在能力命中时走内置浏览器（面板不再
  双开 iframe，改为指路牌 + 状态）；**`tab` 恒走 `window.open` 系统浏览器新标签页**
  ——第一版让两者都进侧边浏览器被用户纠正过。切歌/随机会把新目标**同步推进小窗**；
  内置浏览器不可用/调用失败自动落回 iframe 路径，功能不回退。
- **叶子组件的组合方式**：`sidebar-browser` 的 `package.json` 没有 `dsh.bundle`
  声明，**不能**当 profile bundle 加（loader 报 `declares no dsh.bundle`），必须在
  profile 的 `cordis.patch.yml` 里以 `- insert:` 组合行插入。**web 和 desktop 两个
  profile 的 `cordis.patch.yml` 末尾都已加**；桌面端若落回 iframe（面板出现旧形态），
  把同样的 insert 行加进 desktop patch 即可。

### 状态 HUD（⚙ 面板头部下方一行）

数据面全部**实测**自真实 GUI（诊断句柄 `window.__dshMoyuBreak` + Playwright）：

| 显示 | 数据源 |
| --- | --- |
| ⏱ AI 已工作 / 本轮用时 | 自己记 `running` 翻转的计时器（不依赖任何闭源字段） |
| 🗂 第 N 轮 | `SessionListState.byId[].projectionValues.sessionStats.turns` |
| ✅ 结果摘要 | 同上 `.turnOutline` 最后一轮的 `response` 前 60 字 |
| ⚠ 问题信号 | `.userQuestions.active`（等你回答）/ `.plan.active` |
| 📡 状态字段 | `useSessionStatus` 的防御性渲染（形状未知，命中 `state/kind/error` 才显示） |

根作用域 props 实测只有 7 个（`usePanelInfo/useSessions/useSessionStatus/useWorkspaces/useResource/useSessionRetainInfo/renderFactorySlot`）——会话级的 `lastAgentError`（真正的报错文本）在 `useConversation`/`useSession` 里，**根 overlay 拿不到**，是 HUD 已知边界；等你回答的问题数是目前最贴近"有无问题"的稳定信号。选择器返回值必须**引用稳定**（memo 到 summary 对象），否则 `useSyncExternalStore` 无限重渲染。

### 系统通知（Windows toast，⚙ 可关）

用户反馈：内置浏览器盖住面板后 HUD 全看不见——所以事件改成**任务栏 toast**，人不在 DSH 窗口里也提醒得到。三类事件（`notificationDelta` 纯函数判定，首帧只立基线不弹）：

| toast | 触发 |
| --- | --- |
| **AI 在等你回答** | 快照里 `userQuestions.active` 数量增加 |
| **AI 完成了** | `running` true→false；**延迟 1.5s** 再取答复文本（running 翻转和投影到齐有时间差），正文 = 最后一轮 response 前 120 字 + 用时 |

通道是浏览器 `Notification` API：桌面端 Electron 通常直接 granted（原生 toast）；**网页端可用但权限由浏览器决定**（Playwright 自动化里实测 default→denied）。任何失败都静默——通知是加分项，不影响面板主流程。想手动试通道：控制台 `window.__dshBilibiliBreak.notify('标题','正文')`。⚙ 里可整体关（「系统通知」）。

已知边界：审批类的选项按钮（approval interaction）不在会话摘要投影里，toast 目前覆盖上面三类；「AI 完成了」的正文最多晚 ~1.5 秒出现。

### 小窗布局（⚙ 可关：「内置浏览器用小窗」）

实测 DOM 结构（hash 前缀每次构建会变，选择器用后缀/词根匹配）：右栏 = 零宽 grid 轨道 + `前缀_panel`（absolute 全高）→ 里面是 tabHost/iframe 链。注入 CSS 把它改成**右下 560×680 圆角浮窗**，`:has(iframe[src^="http"])` 把范围钉死在内置浏览器的网页标签（文件树/终端不受影响）。层叠：摸鱼图层 z-70 压过小窗的 z-60（同层会被盖住，实测过）。

真实 GUI 终验 7/7：小窗 fixed/圆角/尺寸、HUD 行、指路牌（不双开 iframe）、面板在小窗之上。截图：`tests-archive/screenshots/b6-final.png`。

## 两个半边

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| host | `index.js` | 观察 durable 的 `turn/start` / `turn/end`；可选地自动开系统浏览器；**启动器路由**与授权判定 |
| host | `lib/picker.js` | 原生文件选择框的驱动：探测 `koffi`、起子进程、把 abort 转成"关掉对话框" |
| host | `lib/picker-worker.cjs` | 真正跑 COM 的子进程入口（`IFileOpenDialog`，选文件模式） |
| client | `lib/client.js` | 询问卡片、摸鱼面板（iframe 嵌入）、启动项编辑器（含「浏览…」）、路由调用 |

主要体验在 client 半边，所以两端行为一致；host 那半的"自动开系统浏览器"默认在 profile 补丁里关掉了（见下）。

## 手动控制

| 操作 | 效果 |
| --- | --- |
| `Ctrl+Shift+B` | 任何时候开关摸鱼面板 |
| 运行中右下角的胶囊 | 点一下直接开面板 |
| 面板头部下方的 HUD 行 | 🕐 工作时长 / 🗂 轮次 / ✅ 结果摘要 / ⚠ 问题信号（实时） |
| 任务栏 toast 通知 | AI 等你回答 / 完成答复（面板被挡时也看得到） |
| 面板 ⚙ | 自动询问开关、**内置浏览器小窗**、**系统通知**、面板尺寸预设、启动项增删改 |
| 点 `embed` 启动项 | 开进**内置浏览器小窗**（右侧栏）；切歌/随机同步推送 |
| 点 `tab` 启动项 | **系统浏览器新标签页**（不进侧边浏览器） |
| 启动项类型选「启动软件」 | 出现路径输入框 + 「浏览…」按钮 |
| 面板顶部的下拉 | 在启动项之间切换 |
| 拖面板边框 / 拖 `⠿` 抓手 | 调大小 / 移动位置（都会记住） |

## 安装

两个 profile 都已装好：

| profile | 包位置 | 清单 |
| --- | --- | --- |
| `desktop` | `$DSH_HOME/profiles/desktop/node_modules/dsh-moyu-break/` | `dependencies` + `dsh.profile.bundles` |
| `web` | `$DSH_HOME/profiles/web/node_modules/dsh-moyu-break/` | 同上 |

正式的安装方式是让 CLI 走 pnpm 并自动对账 `dsh.profile.bundles`：

```sh
dsh plugin --profile web add D:\bilibilichajian\dsh-moyu-break
```

> `desktop` profile 由 Electron 应用独占管理（CLI 会直接拒绝 `--profile desktop`），所以 desktop 那份是手工放置包 + 手工登记 bundle 完成的，没有跑 `pnpm install`——那会在应用运行时重写 `node_modules`。

**bundle 列表和客户端插件表都在启动时构建，所以必须重启 DSH 才生效。**

## 配置（host 半边）

改 `$DSH_HOME/profiles/<name>/cordis.patch.yml`。补丁是**整体替换** `config`，要保留的字段都得重写：

```yaml
- id: moyu-break
  name: dsh-moyu-break
  config:
    enabled: false              # host 半边的「自动开系统浏览器」总开关
    url: https://www.example.com
    delaySeconds: 10
    cooldownSeconds: 600
    maxOpensPerSession: 3
    openInBrowser: true
    allowOpen: true             # 允许客户端让 host 用系统打开 URL/协议
    allowExec: false            # 允许客户端让 host 执行程序（默认关）
    execAllowlist: []
    trustPanelPickedExec: true  # 信任面板里选定的 exe（默认开）
    fenceProbe: false           # 闸门探针：请求头+判决写进 $TMPDIR/moyu-break-fence.ndjson
    launcherTrustedHosts: []    # 非环回 authority 白名单（局域网部署用）
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | host 半边的**自动打开**总开关。两个 profile 里都改成了 `false`，因为弹窗+面板已经覆盖体验，且网页端再开一个标签页没有意义。 |
| `delaySeconds` / `cooldownSeconds` / `maxOpensPerSession` | `10` / `600` / `3` | 自动打开的三重防线。 |
| `openInBrowser` | `true` | 设 `false` 变干跑：只写日志不弹浏览器。 |
| `allowOpen` | `true` | 启动器路由的 `open` 类是否放行。 |
| `allowExec` | `false` | `exec` / `exe` 两类是否放行。**默认关，需显式打开。** |
| `execAllowlist` | `[]` | 非空时只放行名单内的可执行文件（归一化后全等，或以 `\<名字>` / `/<名字>` 结尾）。留空表示不再收窄。 |
| `trustPanelPickedExec` | `true` | 是否信任面板里当场选定的 exe 路径。设 `false` 回到"必须手写进 `execAllowlist`"。见上面的安全模型。 |
| `fenceProbe` | `false` | 闸门诊断探针：每次 `/hello`、`/launch`、`/pick-file` 把原始请求头与闸门判决追加写进 `$TMPDIR/moyu-break-fence.ndjson`（每次启动清空一次）。**只在诊断时打开**——桌面端 403 事故靠它一次定位到"窗口不带 `sec-fetch-site` 头"，诊断完已关回。 |
| `launcherTrustedHosts` | `[]` | 闸门默认只认环回 Host（防 DNS rebinding）。通过局域网/域名访问 DSH 且需要面板 host 路由时，把 authority（`host` 或 `host:port`）写在这里。 |

客户端那半的「10 秒」阈值写在 `lib/client.js` 的 `ASK_DELAY_MS`，自动询问开关、面板尺寸、**内置浏览器小窗**在面板 ⚙ 里改（存 localStorage）。

**web profile 还需要一条内置浏览器的组合行**（方案 B 的前提，桌面端视 desktop 壳而定）：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml 末尾
- insert:
    - id: sidebar-browser
      name: "@deepseek-ai/dsh-client-ui-sidebar-browser"
```

> 叶子组件没有 `dsh.bundle` 声明，写进 `package.json` 的 bundles 会被 loader 拒
> （`declares no dsh.bundle`），只能以 profile 补丁的 `insert` 行组合进插件树。

## 验证

```sh
cd $DSH_HOME/profiles/desktop/node_modules/dsh-moyu-break
node --test test/*.test.js
```

> 必须在**已安装副本**目录下跑：依赖（`@deepseek-ai/schemastery` 等）只在 profile 的 `node_modules` 里，在源码目录跑会 `ERR_MODULE_NOT_FOUND`。

**92 个测试，六层**：

- `test/plugin.test.js` —— host 侧纯逻辑（配置归一化、开不开的决策、各平台启动命令）、假上下文的调度行为、路由注册（含"没有 webServer 时安静跳过"）。
- `test/integration.test.js` —— 在**真实 cordis 根**上装载 host 半边，验证 `inject` 依赖门控、`Config` schema 校验、事件派发。
- `test/launcher.test.js` —— 启动器的纯校验函数与授权判定：请求闸门正反用例（Host 环回/rebind、trustedHosts、cross-site、Origin 一致性、缺头放行——桌面端事故的回归护栏）、`open` 的 scheme 白名单、`exec` 的参数边界、`authorizeExec` 的五条分支（名单命中 / `userChosen` 豁免 / 信任集合 / 开关关闭 / 默认拒绝）、`pathKey` 的归一化。
- `test/launcher-http.test.js` —— **真实 HTTP** 打安全门。把 `apply` 注册的 handler 挂到真实的 `node:http` 服务器上再用 `fetch` 打过去，`req.headers` 行为与真实部署一致；覆盖跨源头缺失/伪造、token 缺失/错误、恶意目标、`exec` 默认关闭、allowlist 拦截、信任集合的记住与复用、`/pick-file` 的选中/取消/报错三条路径、`fenceProbe` 探针落盘。**伪造 `sec-fetch-site`/`Origin` 的用例用原始 `http.request` 发**——fetch 会剥掉这类"受保护头"。**picker 用测试替身注入**（`__setPickerImpl`）—— 真实实现会弹出模态对话框并一直等，测试会挂死。
- `test/client.test.js` —— 把客户端 bundle 当浏览器脚本求值：loader 包装契约、`shell.overlay` 注册形状、样式注入；用 `react-dom/server` 真渲染；启动器数据模型（v1→v2 迁移、非法输入收敛、游标折回、BV 解析、`exe` 类型）；两条运行位推导的回归用例；方案 B 七件套（内置浏览器能力探测正反例、调用形状、小窗偏好默认值、小窗 CSS 选择器形状、`computeHudValue` 从实测字段面提状态、`notificationDelta` 通知事件判定、系统通知开关默认值）。
- `test/picker.test.js` —— 文件选择器：`resolveNodeBinary` 的四条分支（非 Electron 用 execPath、`DSH_PICKER_NODE` 覆盖、Electron 从 `$DSH_HOME/dsh-runtimes` 找独立 Node——桌面端 koffi 崩溃修复的核心回归——、找不到时回退）、非 Windows 的明确降级。

### 在真实浏览器里验收过

`D:\bilibilichajian\.test\` 是配套的 Playwright 验收脚手架（用系统已装的 Edge，不需要下载 Chromium）。

| 项 | 结果 |
| --- | --- |
| 客户端插件进入启动图 | `{"id":"dsh-moyu-break","inject":["…runtime","…ui-layout"]}` |
| 在真实浏览器里挂载 | 样式标签 + `<div class="dbb-layer">`，无 page error |
| 根作用域拿到标准 props | `data-dbb-hook="true"` —— `shell.overlay` 确实收得到 `useSessions` |
| 运行 → 阈值 → 询问卡片 | 提交后 ~1.3s 识别到 running，阈值到点弹出 |
| **卡片用自定义文案 + 每个启动项一个按钮** | `CUSTOM: AI 正在工作，来摸一会鱼吧~` + `["🎬 摸鱼站","🌐 示例站点","🖥 本地程序"]` + 「不用了」 |
| **embed → 面板 + 播放器** | iframe 指向 `player.example.com/player.html?bvid=…`，**播放器真的出画面** |
| **tab → 新标签页** | 新页面确实创建并导航（顺带确认 DSH 的 web 界面**不会**拦截 `window.open`） |
| **host → 客户端到 host 完整往返** | 用一个必然被校验层拒绝的本地路径，收到了 host 侧的错误并显示为提示——零副作用地证明了整条链路 |
| **⚙ 编辑器** | 回填自定义文案、列出全部启动项、提供四种启动方式、改动落到 `localStorage` |
| 「不用了」 | 同一个 run 内卡片不再出现 |
| 面板几何 | `bottom=884 / viewport=900`（16px 边距），无 transform 祖先破坏 fixed 定位 |

> 注意：验收脚本跑的时候，web 上那份的 `ASK_DELAY_MS` 被临时降到 2000ms——这台机器的模型太快，普通任务撑不到 10 秒。**交付物里是 10000ms**，两个 profile 里安装的副本与交付源码逐字节一致。

host 半边的自动打开也实测过：在打包运行时里能识别 turn → 忙过阈值 → 调用 `launchBrowser`（系统浏览器确实被拉起）。

## 踩过的坑（改这个插件前必读）

1. **host 半边：bundle 插件行的 `inject` 必须写在补丁行的 YAML 里。**

   ```yaml
   - insert:
       - id: moyu-break
         name: dsh-moyu-break
         inject:      # ← 必须在这里
           - timer
   ```

   只写模块里的 `export const inject = ['timer']` 不够：作为 profile bundle 挂载时 loader 读的是**行上**的 `inject`（`dsh-base` 的 `headless-runner` 行也是这么写的）。少了这一份，插件的 `apply` 会正常跑完、监听器也正常注册、事件也正常送达，但第一次碰 `ctx.timeout` 就抛 `cannot get property "timer" without inject`，而**事件派发会把这个异常静默吞掉**——插件看起来装上了但永远不动作。完全不报错，所以极难查。

2. **`dsh.client.inject` 是纯信息性的。** 它只用于预检展示和 HMR 差异，**不参与激活顺序**；激活只靠 cordis 在*服务*上的等待。所以等 slot 声明必须用 `ctx.slots.inject('shell.overlay', ...)`。

3. **`dsh.client.platform` 必须是 `'web'`，且 `exports["./client"]` 必须存在**，否则启动时直接抛 `client-modules: <pkg> declares dsh.client but exports no "./client" bundle`。

4. **`shell.overlay` 图层本身是点击穿透的**，交互元素要自己 `pointer-events: auto`（`client.js` 里 `.dbb-layer > *` 做了这件事）。

5. **手写 bundle 不经过打包器**：外部依赖只能从冻结的模块表 `require`（`react`、`react-dom`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots` 等，完整列表见 `packages/client/web/src/platform.ts`），并且要自己用 `window.__ModuleLoader__.load({ id, factory })` 包一层并 `return module.exports`。

6. **别把运行位绑死在 `SessionListState.current` 上。** 在「新会话」视图下 `current` 是 `undefined`，而此时 turn 已经在跑了——只认 `current` 的话运行位会永远短路成 `false`，弹窗一次都不会出现。**这个坑完全不报错**（渲染正常、无异常、就是永不触发），我们是在浏览器里 dump `SessionListState` 才看见 `current` 字段从 JSON 里整个消失（`JSON.stringify` 丢掉 `undefined`）才定位到的。现在的写法是 `current` 落位时优先用它，否则退回扫描 `byId`；两条路径都有回归测试。

   顺带一个反直觉点：**运行位不在任何 `data-phase` 上**。`InputBar` 的 `data-phase` 是提交状态机（`plain|adjudicating|claimed|submitting`），`ConversationRoot` 的是内容阶段（`hero|active|settling`），两者都不是「agent 正在跑」。真正的运行位是 `SessionSummary.running`（列表）与 `ConversationSnapshot.running`（会话）。

7. **`window.open` 不要带 `features` 里的 `noopener`。** 按规范只要带它，返回值**必定是 null**，于是「被拦截」的检测会永远误报。正确做法是拿到引用后手动 `opened.opener = null`——既保住返回值，安全性一样。这个 bug 是浏览器验收抓到的（回馈永远显示"浏览器拦截了新标签页"）。

8. **`open` 类的 scheme 正则必须要求至少两个字符。** 写 `[a-z][a-z0-9+.-]*` 的话，`C:\Windows\System32\cmd.exe` 会被解析成 scheme `c`，**裸 Windows 路径就被放行了**。真实 scheme 没有单字母的，收紧成 `+` 即可。这个 bug 是单测抓到的。

9. **纯 Node 测过的原生链路，在 Electron 宿主下可能直接崩。** picker 的整条链（对话框弹出、选中、回传路径）在纯 Node 下全绿，但桌面端 host 跑在 Electron 的 Node 里——koffi 在 `koffi.view()` 处触发 `napi_is_detached_arraybuffer` **SIGABRT**，worker 悄悄死掉，HTTP 只能报 500，UI 表现是"对话框关了但地址没回填"，用户根本看不到 crash 堆栈。定位靠的是隔离复现：把 worker 单独用 `DeepSeek Harness.exe`（`ELECTRON_RUN_AS_NODE=1`）拉起来跑一遍，堆栈立刻指向 `readUtf16`。**教训：宿主进程的 Node 是不是"你以为的那个 Node"，必须显式验证**（`process.versions.electron`），跑宿主子进程的东西不要无条件用 `process.execPath`。另：worker 发完消息立刻退出，父端要在 `close`（而不是 `exit`）上判失败，否则 IPC 消息还没投递就被判成失败。

10. **`<webview>` 一旦 `display: block`，guest 视口高度永久冻结在 150px。** Electron 44 的怪癖：宽度会跟着元素同步（1280 ✓），高度钉死在默认 150 且永不更新——页面只有一条缝高，`elementFromPoint` 全是 null，缩放坐标点击全部落空。保持默认 inline 就正常（800 ✓）。**症状极具迷惑性**：布局里元素明明是 1280×800（`offsetHeight=800`），错的只是 guest 内部的 `window.innerHeight`，从外观看一切正常。这个 bug 的排查绕了十几个弯（profile、partition、dpr、窗口位置、Electron 小版本全试过），最后靠**文件级二分**定罪。附两条方法论教训：① **"注入样式 + reload 再测"是空测**——reload 会把注入的样式冲掉，页面回到原文件状态，测了个寂寞（我因此得出过好几轮假"800"）；② 二分必须**一次只改一个文件变量、每轮重新起进程**。

11. **探针环境全绿 ≠ 宿主应用里能用。** webview 方案在独立 Electron（同版本内核）里全链路通过后直接上了真实 DSH，结果"面板内嵌完全打不开/黑屏"。探针是**裸 BrowserWindow**，而真实应用是宿主自己的壳——`will-attach-webview` 拦截、webviewTag 的实际开关、会话/协议限制，这些都是**应用层策略**，探针结构上测不到。教训：涉及宿主应用资源（webview、协议、窗口、IPC）的功能，验证必须落在真实宿主里，探针只能证明"技术可行"；没过真实关的功能**不该出现在产品里**（方案 A 最终整体剥离，见上文「方案 A（已搁置）」）。

12. **碰闭源 ctx 服务必须 `ctx.get(name)`，不能 `ctx.name`。** 直接属性访问走 cordis 的 inject 代理门，没在 `inject` 里声明就抛 `cannot get property "sidebarRight" without inject`——而且**同步抛在渲染/事件路径里**，本插件的 `try/catch` 兜住了才没白屏，第一次 Playwright 取证就是被它打断的。DSH 自家代码两种写法都有：声明了 inject 的用直连，可选用 `ctx.get('sidebarRightTabs')?.get(...)` 做存在性探测——**对外部插件，`ctx.get` 是唯一安全姿势**（不存在时返回 undefined 而不是抛）。

## 实现要点

- 运行态读框架给根作用域组件的标准 props（`useSessions`），**完全不需要 host 配合**；只有 `host`/`exe`/`exec` 几类才回 host，走同源路由。
- 定时器用 `React.useEffect` + `setTimeout`，cleanup 里清掉。用 `async` 处理函数时注意：`window.open` 必须在任何 `await` 之前调用，否则会脱离用户手势而被拦截（当前实现对 `tab` 类满足这一点）。
- host 侧 Windows 用 `rundll32.exe url.dll,FileProtocolHandler <url>` 而不是 `cmd /c start`（后者会让 URL 经过 cmd 二次解析，查询串里的 `&` 会被当成命令分隔符）。macOS 用 `open`，Linux 用 `xdg-open`。
- 数据模型带版本号，`migrateSettings` 负责把 v1（单一片单）迁移成 v2（启动项列表），垃圾输入一律回落到默认而不是留半个坏状态。
- **结构校验与授权分开**：`parseLaunchRequest` 只回答"形状对不对"（400），`authorizeExec` 回答"准不准跑"（403）。早期版本把 allowlist 判断放在前者，结果运行时信任集合永远没机会生效——面板里选过的路径照样被拒。这个顺序是功能正确性的一部分，不只是分层洁癖。
- **原生对话框的 COM 细节**：`IFileOpenDialog` 的 vtable 槽位（`SetFileTypes`=4、`SetOptions`=9、`SetTitle`=17、`GetResult`=20）是 Vista 以来冻结的 ABI；`SetOptions` 用 `FOS_FORCEFILESYSTEM|FOS_PATHMUSTEXIST|FOS_FILEMUSTEXIST`（`0x1048`）。需要"选文件"而不是"选目录"，差别就在这一位。`koffi` 只动态 import，非 Windows 进程不会加载它。

## 已知限制

- **自动询问只对单轮持续超过阈值生效**。如果 agent 连做 20 个 5 秒的小轮次，你等了 100 秒也不会触发（10 秒阈值之内不会有任何打扰，这是刻意的）。
- `execAllowlist` 是**归一化后全等或后缀**匹配，不是完整的规范化路径比较（不解析 `..`、符号链接、8.3 短名）。它是一道防误触的闸，不是防恶意代码的沙箱——能改插件配置的人本来就能让 host 执行任何东西。
- 原生文件选择框**只实现了 win32**。macOS / Linux 上「浏览…」会退回手填路径。
- 网页端能不能弹选择框，取决于**跑 DSH 服务端的那台机器**是不是你面前这台。远程访问时对话框会出现在服务器屏幕上（或根本弹不出来）。
- `embed` 只对允许 iframe 的站点有效。不允许的（很多站点用 JS 防嵌套）请用 `tab`。
- **视频页面里的视频链接是 `target="_blank"`**。`embed` 里嵌视频首页/播放页，点视频会开新标签页（跨源 iframe 改不了别人的链接属性）——这是 iframe 的天花板。网页端想原地看视频，`embed` 目标填 BV 号走官方播放器地址。
- **方案 A（桌面端 webview 内嵌）已搁置**：真实 DSH 窗口里黑屏，产品代码已剥离，当前恒为 iframe（详见上文「方案 A（已搁置）」）。
- 网页端想原地看视频：`embed` 目标填 BV 号走官方播放器地址（iframe 的天花板只有这一条缝）。
- `localStorage` 按源存，`dsh web` 换端口会看到一份新的空配置。
- **host 路由默认只认环回 Host**。经局域网 IP / 域名访问 DSH 时，面板的 `host`/`exe`/`exec` 会被 403（`embed`/`tab` 不受影响，它们不回 host）；需要就往 `launcherTrustedHosts` 里写 authority。
- `tab` 类在桌面端（Electron）的行为可能与网页端不同——我在网页端实测过，桌面端没测过；如果你在桌面端点 `tab` 有异常，欢迎反馈。
- host 半边的自动打开是"每进程"记冷却：重启 DSH 后冷却清零。运行时信任集合也是每进程，重启即清空（这是有意设计）。
