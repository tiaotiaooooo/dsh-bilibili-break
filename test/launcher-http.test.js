/**
 * 启动器路由的真实 HTTP 验收。
 *
 * 单测覆盖了纯校验函数，但「跨源头缺失/伪造」「token 不对」「配置开关」这些是
 * 网络层的事实，必须用真实请求打。这里不启动 DSH：把 apply() 注册的 handler
 * 挂到一个真实的 node:http 服务器上，再用 fetch 打过去 —— req.headers 的行为
 * 和真实部署完全一致。
 *
 * 副作用控制：故意让 `open` 被配置关掉（403），只放行一条 `exec`，且执行的是
 * `process.execPath -e "process.exit(0)"` —— 跨平台、无输出、瞬时结束。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { basename, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { apply, ROUTE_PREFIX, __setPickerImpl } from '../index.js'
import { isFilePickerSupported } from '../lib/picker.js'

/**
 * `pickable` 能力位取决于这台机器有没有 koffi —— 有真 koffi 的开发机上是 true，
 * CI 或别的平台上可能是 false。测试不该写死其中一种，所以现探一次再断言。
 */
const expectPickable = (await isFilePickerSupported()).ok

/** 一个只够 apply() 用的假上下文，webServer.register 把路由收进表里。 */
function createHarnessContext(routes) {
  return {
    logger: { info() {}, warn() {} },
    on() {},
    timeout: () => () => {},
    effect: () => {},
    inject(deps, callback) {
      if (!deps.includes('webServer')) return undefined
      callback({
        effect: (fn) => fn(),
        webServer: {
          register(spec) {
            routes.set(spec.path, spec.handler)
            return () => {}
          },
        },
      })
      return undefined
    },
  }
}

/** 起一个真实 HTTP 服务器，只挂插件注册的那几条路由。 */
async function startHarness(config) {
  const routes = new Map()
  // apply 是 async 的（注册路由前要探一次原生文件选择框），必须 await，
  // 否则下面的 fetch 会打在还没注册完的空表上 —— 表现是一律 403。
  await apply(createHarnessContext(routes), config)

  const server = createServer((req, res) => {
    const path = String(req.url ?? '').split('?')[0]
    const handler = routes.get(path)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'no route' }))
      return
    }
    Promise.resolve(handler(req, res)).catch((error) => {
      try {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
      } catch {
        // 响应可能已经发出去了。
      }
    })
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections?.()
      server.close()
      await once(server, 'close')
    },
  }
}

/** 浏览器会带的同源标记；不带就是「非浏览器请求」。 */
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' }

const post = (base, body, headers = {}) =>
  fetch(`${base}${ROUTE_PREFIX}/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

const get = (base, headers = {}) => fetch(`${base}${ROUTE_PREFIX}/hello`, { headers })

const harnessConfig = {
  enabled: false,
  allowOpen: false,
  allowExec: true,
  execAllowlist: [basename(process.execPath)],
}

test('HTTP：/hello 同源可取 token 与能力位', async () => {
  const harness = await startHarness(harnessConfig)
  try {
    const response = await get(harness.base, SAME_ORIGIN)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(typeof payload.token, 'string')
    assert.ok(payload.token.length > 20)
    assert.deepEqual(payload.capabilities, { open: false, exec: true, pickable: expectPickable })

    // 每次启动的 token 应该是随机的，不能是常量。
    const other = await startHarness(harnessConfig)
    try {
      const second = await (await get(other.base, SAME_ORIGIN)).json()
      assert.notEqual(second.token, payload.token)
    } finally {
      await other.close()
    }
  } finally {
    await harness.close()
  }
})

test('HTTP：缺 sec-fetch-site 时 /hello 放行、/launch 被 token 挡下', async () => {
  // 旧语义是「缺头一律 403」——正是它把桌面端 Electron 窗口的握手打死了。
  // 新语义：闸门只认 Host 环回与显式 cross-site，缺头是合法形态；
  // POST 仍被 token 挡住，所以安全性不降级。
  const harness = await startHarness(harnessConfig)
  try {
    assert.equal((await get(harness.base)).status, 200, '缺标记的 GET /hello 应放行')
    const denied = await post(harness.base, { action: 'open', target: 'https://x.test' })
    assert.equal(denied.status, 403)
    assert.match((await denied.json()).error, /token/, 'POST 缺 token 仍要 403')
  } finally {
    await harness.close()
  }
})

/** 用原始 http 发请求：fetch 会剥掉 sec-fetch-site/Origin 这类"受保护头"，
 *  手动拼头才能确定服务端收到的就是要测的那个值。 */
function rawRequest(base, { path, method = 'POST', headers = {} }) {
  const url = new URL(path, base)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    if (method === 'POST') request.write('{}')
    request.end()
  })
}

test('HTTP：显式 cross-site 标记被 403（CSRF 主门）', async () => {
  const harness = await startHarness(harnessConfig)
  try {
    const response = await rawRequest(harness.base, {
      path: `${ROUTE_PREFIX}/launch`,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(response.status, 403)
    assert.match(JSON.parse(response.body).error, /cross-origin/)
  } finally {
    await harness.close()
  }
})

test('HTTP：Origin 与 Host 不一致被 403（带标记时的一致性校验）', async () => {
  const harness = await startHarness(harnessConfig)
  try {
    const response = await rawRequest(harness.base, {
      path: `${ROUTE_PREFIX}/launch`,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://evil.test' },
    })
    assert.equal(response.status, 403)
    assert.match(JSON.parse(response.body).error, /origin/)
  } finally {
    await harness.close()
  }
})

test('HTTP：闸门探针（fenceProbe）把原始请求头与判决写进文件', async () => {
  const probePath = join(tmpdir(), 'dsh-bilibili-break-fence.ndjson')
  const harness = await startHarness({ ...harnessConfig, fenceProbe: true })
  try {
    await get(harness.base)
    await post(harness.base, { action: 'open', target: 'https://x.test' })
    const lines = readFileSync(probePath, 'utf8').split('\n').filter((line) => line.trim() !== '')
    assert.ok(lines.length >= 2, '应记录 GET 与 POST 两行')
    const hello = lines.map((line) => JSON.parse(line)).find((entry) => entry.route === 'hello')
    assert.equal(hello.verdict, 'ok')
    assert.ok(typeof hello.headers.host === 'string' && hello.headers.host.includes('127.0.0.1'))
    const launch = lines.map((line) => JSON.parse(line)).find((entry) => entry.route === 'launch')
    assert.equal(launch.verdict, 'token-403', '无 token 的 POST 应记 token-403')
  } finally {
    await harness.close()
  }
})

test('HTTP：方法不对返回 405', async () => {
  const harness = await startHarness(harnessConfig)
  try {
    const helloByPost = await fetch(`${harness.base}${ROUTE_PREFIX}/hello`, { method: 'POST', headers: SAME_ORIGIN })
    assert.equal(helloByPost.status, 405)
    assert.equal(helloByPost.headers.get('allow'), 'GET')

    const launchByGet = await fetch(`${harness.base}${ROUTE_PREFIX}/launch`, { headers: SAME_ORIGIN })
    assert.equal(launchByGet.status, 405)
    assert.equal(launchByGet.headers.get('allow'), 'POST')
  } finally {
    await harness.close()
  }
})

test('HTTP：token 缺失或不对一律 403', async () => {
  const harness = await startHarness(harnessConfig)
  try {
    const body = { action: 'open', target: 'https://x.test' }
    assert.equal((await post(harness.base, body, SAME_ORIGIN)).status, 403)
    assert.equal((await post(harness.base, body, { ...SAME_ORIGIN, 'x-dsh-bilibili-break-token': 'wrong' })).status, 403)

    const { token } = await (await get(harness.base, SAME_ORIGIN)).json()
    const withToken = await post(harness.base, body, { ...SAME_ORIGIN, 'x-dsh-bilibili-break-token': token })
    // token 对了，但 allowOpen 关着 -> 403（配置门），错误信息应该不同。
    assert.equal(withToken.status, 403)
    assert.match((await withToken.json()).error, /allowOpen/)
  } finally {
    await harness.close()
  }
})

test('HTTP：恶意目标在校验层就被 400 挡下', async () => {
  const harness = await startHarness(harnessConfig)
  try {
    const { token } = await (await get(harness.base, SAME_ORIGIN)).json()
    const headers = { ...SAME_ORIGIN, 'x-dsh-bilibili-break-token': token }

    // scheme 相关的目标在结构校验层就 400，不会走到授权层。
    for (const target of ['file:///C:/Windows/System32/cmd.exe', 'javascript:alert(1)', 'not a url']) {
      const response = await post(harness.base, { action: 'open', target }, headers)
      assert.equal(response.status, 400, `${target} 应被 400 拒绝`)
    }
    // 未知 action
    assert.equal((await post(harness.base, { action: 'wipe' }, headers)).status, 400)
    // 畸形 JSON
    const malformed = await fetch(`${harness.base}${ROUTE_PREFIX}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: '{ not json',
    })
    assert.equal(malformed.status, 400)
  } finally {
    await harness.close()
  }
})

test('HTTP：exec 受 allowlist 约束，放行的目标真的会被启动', async () => {
  const harness = await startHarness(harnessConfig)
  try {
    const { token } = await (await get(harness.base, SAME_ORIGIN)).json()
    const headers = { ...SAME_ORIGIN, 'x-dsh-bilibili-break-token': token }

    // 不在名单里 -> 403（授权门，不是请求格式错）
    const denied = await post(harness.base, { action: 'exec', target: 'definitely-not-allowed.exe' }, headers)
    assert.equal(denied.status, 403)
    assert.match((await denied.json()).error, /execAllowlist/)

    // 在名单里 -> 200，且真的 spawn 了一次（用 node 自己跑一句立刻退出的代码，无输出）。
    const allowed = await post(
      harness.base,
      { action: 'exec', target: process.execPath, args: ['-e', 'process.exit(0)'] },
      headers,
    )
    assert.equal(allowed.status, 200)
    assert.equal((await allowed.json()).ok, true)
  } finally {
    await harness.close()
  }
})

test('HTTP：trustPanelPickedExec 关掉后，userChosen 拿不到豁免', async () => {
  const harness = await startHarness({ ...harnessConfig, trustPanelPickedExec: false })
  try {
    const { token } = await (await get(harness.base, SAME_ORIGIN)).json()
    const response = await post(
      harness.base,
      { action: 'exec', target: 'definitely-not-allowed.exe', userChosen: true },
      { ...SAME_ORIGIN, 'x-dsh-bilibili-break-token': token },
    )
    assert.equal(response.status, 403)
    assert.match((await response.json()).error, /execAllowlist/)
  } finally {
    await harness.close()
  }
})

test('HTTP：userChosen 的路径被记住，之后不带 userChosen 也放行，别的路径仍被拒', async () => {
  // 名单故意设成一条匹配不上的，确保走的是信任集合那条路，而不是静态名单。
  const harness = await startHarness({ ...harnessConfig, execAllowlist: ['nothing-matches.exe'] })
  try {
    const { token } = await (await get(harness.base, SAME_ORIGIN)).json()
    const headers = { ...SAME_ORIGIN, 'x-dsh-bilibili-break-token': token }
    const target = process.execPath

    const first = await post(harness.base, { action: 'exec', target, args: ['-e', 'process.exit(0)'], userChosen: true }, headers)
    assert.equal(first.status, 200, 'userChosen 应放行')

    // 第二次不带 userChosen（模拟启动项被重复触发）也应放行：已经记住了。
    const second = await post(harness.base, { action: 'exec', target, args: ['-e', 'process.exit(0)'] }, headers)
    assert.equal(second.status, 200, '记住之后不该要求再次 userChosen')

    // 另一条没被选过的路径仍然被拒。
    const other = await post(harness.base, { action: 'exec', target: 'other-thing.exe' }, headers)
    assert.equal(other.status, 403)
    assert.match((await other.json()).error, /execAllowlist/)
  } finally {
    await harness.close()
  }
})

test('HTTP：/pick-file 缺 token 一律 403', async () => {
  const harness = await startHarness(harnessConfig)
  try {
    const response = await fetch(`${harness.base}${ROUTE_PREFIX}/pick-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...SAME_ORIGIN },
      body: JSON.stringify({ title: 'test' }),
    })
    assert.equal(response.status, 403)
  } finally {
    await harness.close()
  }
})

test('HTTP：/pick-file 走替身能取回选中路径，取消则返回 null', async () => {
  // 装替身是必须的：真实实现会弹出模态对话框并一直等，测试会挂死。
  const seen = []
  __setPickerImpl(async (options) => {
    seen.push(options.title)
    return options.title.includes('取消') ? null : 'C:\\Games\\Foo\\foo.exe'
  })
  try {
    const harness = await startHarness(harnessConfig)
    try {
      const { token } = await (await get(harness.base, SAME_ORIGIN)).json()
      const headers = { 'content-type': 'application/json', ...SAME_ORIGIN, 'x-dsh-bilibili-break-token': token }

      const picked = await fetch(`${harness.base}${ROUTE_PREFIX}/pick-file`, {
        method: 'POST', headers, body: JSON.stringify({ title: '选个程序' }),
      })
      assert.equal(picked.status, 200)
      assert.deepEqual(await picked.json(), { ok: true, path: 'C:\\Games\\Foo\\foo.exe' })

      const cancelled = await fetch(`${harness.base}${ROUTE_PREFIX}/pick-file`, {
        method: 'POST', headers, body: JSON.stringify({ title: '取消一下' }),
      })
      assert.equal(cancelled.status, 200)
      assert.deepEqual(await cancelled.json(), { ok: true, path: null })

      // 标题透传，超长标题被截断到 120。
      const long = await fetch(`${harness.base}${ROUTE_PREFIX}/pick-file`, {
        method: 'POST', headers, body: JSON.stringify({ title: 'x'.repeat(500) }),
      })
      assert.equal(long.status, 200)
      assert.equal(seen.at(-1).length, 120)

      // 替身抛错 -> 500，且错误信息回传。
      __setPickerImpl(async () => { throw new Error('对话框炸了') })
      const failed = await fetch(`${harness.base}${ROUTE_PREFIX}/pick-file`, {
        method: 'POST', headers, body: JSON.stringify({}),
      })
      assert.equal(failed.status, 500)
      assert.match((await failed.json()).error, /对话框炸了/)
    } finally {
      await harness.close()
    }
  } finally {
    __setPickerImpl(null)
  }
})

test('HTTP：exec 默认关闭（allowExec 缺省即 false）', async () => {
  const harness = await startHarness({ enabled: false, allowOpen: false })
  try {
    const { token, capabilities } = await (await get(harness.base, SAME_ORIGIN)).json()
    assert.equal(capabilities.exec, false)
    const response = await post(
      harness.base,
      { action: 'exec', target: process.execPath, args: ['-e', 'process.exit(0)'] },
      { ...SAME_ORIGIN, 'x-dsh-bilibili-break-token': token },
    )
    assert.equal(response.status, 403)
    assert.match((await response.json()).error, /allowExec/)
  } finally {
    await harness.close()
  }
})

test('HTTP：未知路径不落到插件路由上', async () => {
  const harness = await startHarness(harnessConfig)
  try {
    assert.equal((await fetch(`${harness.base}/_dsh/bilibili-break/nope`, { headers: SAME_ORIGIN })).status, 404)
  } finally {
    await harness.close()
  }
})
