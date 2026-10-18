/**
 * 启动器请求校验与安全门的单测。
 *
 * 这些纯函数是这次改造里唯一有安全影响的部分：它们决定「界面里的代码能否让你的
 * 电脑打开一个地址 / 执行一个程序」。所以每道门都要有正反用例。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  authorizeExec,
  checkRequestFence,
  ExecTrustSet,
  isAllowedArgs,
  isAllowedExecTarget,
  isAllowedOpenTarget,
  parseLaunchRequest,
  pathKey,
} from '../index.js'

// ── 请求闸门 ──────────────────────────────────────────────────────────────────
//
// 闸门模型对齐 DSH 自家 /api（api-request-trust.ts）：Host 环回绑定是防 DNS
// rebinding 的主门，sec-fetch-site 只拒显式 cross-site，头缺失是合法形态。
// 旧版要求「sec-fetch-site 必须存在且为 same-origin」——把桌面端 Electron 窗口的
// fetch 打死过（真实事故），别再改回去。

test('闸门：方法不匹配返回 405', () => {
  const verdict = checkRequestFence({ method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }, 'GET')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 405)
})

test('闸门：Host 必须存在且是环回（防 DNS rebinding 的主门）', () => {
  // 没有 Host 头（HTTP/1.0、伪造）→ 拒。
  assert.equal(checkRequestFence({ method: 'GET', headers: {} }, 'GET').ok, false)
  // rebind 攻击：页面来自攻击者域名，Host 就是攻击者域名 → 拒。
  const rebound = checkRequestFence({ method: 'GET', headers: { host: 'evil.test:19387' } }, 'GET')
  assert.equal(rebound.ok, false)
  assert.equal(rebound.status, 403)
  assert.match(rebound.error, /loopback/)
  // 本机三种写法 → 放行。
  for (const host of ['127.0.0.1:19387', '127.0.0.2:80', 'localhost:19399', '[::1]:19387']) {
    assert.equal(checkRequestFence({ method: 'GET', headers: { host } }, 'GET').ok, true, `${host} 应放行`)
  }
  // 垃圾 Host → 拒。
  assert.equal(checkRequestFence({ method: 'GET', headers: { host: 'not a host\r\n' } }, 'GET').ok, false)
})

test('闸门：非环回 Host 命中 trustedHosts 时放行（远程 web 部署）', () => {
  const req = { method: 'GET', headers: { host: '192.168.1.5:19387' } }
  assert.equal(checkRequestFence(req, 'GET').ok, false, '默认只认环回')
  assert.equal(
    checkRequestFence(req, 'GET', { trustedHosts: ['192.168.1.5:19387'] }).ok,
    true,
    '显式信任的 authority 应放行',
  )
  assert.equal(
    checkRequestFence(req, 'GET', { trustedHosts: ['other.test'] }).ok,
    false,
    '信任别的域名不该连带放行',
  )
})

test('闸门：sec-fetch-site 缺失放行（桌面端非标准窗口/curl 的真实形态）', () => {
  // 这就是那次桌面端 403 事故的修复：旧版把头缺失当攻击，桌面窗口恰恰缺这个头。
  for (const headers of [{}, { 'sec-fetch-site': '' }, undefined]) {
    const verdict = checkRequestFence({ method: 'POST', headers: { host: '127.0.0.1:1', ...headers } }, 'POST')
    assert.equal(verdict.ok, true, `headers=${JSON.stringify(headers)} 应放行`)
  }
})

test('闸门：显式 cross-site 被拒（CSRF 主门）', () => {
  const verdict = checkRequestFence({ method: 'POST', headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'CROSS-SITE' } }, 'POST')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 403)
  assert.match(verdict.error, /cross-origin/)
})

test('闸门：同源/none/same-site 放行', () => {
  for (const site of ['same-origin', 'none', 'same-site']) {
    const verdict = checkRequestFence({ method: 'POST', headers: { host: '127.0.0.1:1', 'sec-fetch-site': site } }, 'POST')
    assert.equal(verdict.ok, true, `${site} 应放行`)
  }
})

test('闸门：有标记时 Origin 必须与 Host 一致；不透明源（null）拒绝', () => {
  const base = { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' }
  // 一致 → 放行。
  assert.equal(
    checkRequestFence({ method: 'POST', headers: { ...base, origin: 'http://127.0.0.1:19387' } }, 'POST').ok,
    true,
  )
  // 跨源 Origin（表单/跨域 fetch 会带）→ 拒。
  const bad = checkRequestFence({ method: 'POST', headers: { ...base, origin: 'http://evil.test' } }, 'POST')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /origin/)
  // 沙箱 iframe / file: 页面的字面量 "null" → 拒。
  assert.equal(
    checkRequestFence({ method: 'POST', headers: { ...base, origin: 'null' } }, 'POST').ok,
    false,
  )
  // 但没有标记时跳过 Origin 检查（Electron 非标准窗口的容错面）。
  assert.equal(
    checkRequestFence({ method: 'POST', headers: { host: '127.0.0.1:19387', origin: 'dsh-app://bundle' } }, 'POST').ok,
    true,
    '缺标记时以 Host 环回为准，不因自定义协议 Origin 误杀',
  )
})

// ── open 类：只接受带 scheme 的地址 ──────────────────────────────────────────

test('open 类：放行正常的地址与协议', () => {
  for (const target of [
    'https://www.example.com',
    'http://127.0.0.1:8080/x?y=1&z=2',
    'steam://run/730',
    'spotify:track:abc',
    'mailto:a@b.c',
  ]) {
    assert.equal(isAllowedOpenTarget(target), true, `${target} 应放行`)
  }
})

test('open 类：拒绝 file/data/javascript/vbscript（那是本地文件与脚本入口）', () => {
  for (const target of ['file:///C:/Windows/System32/cmd.exe', 'data:text/html,<script>', 'javascript:alert(1)', 'vbscript:x', 'blob:http://x']) {
    assert.equal(isAllowedOpenTarget(target), false, `${target} 应被拒绝`)
  }
})

test('open 类：拒绝没有 scheme 的裸路径与命令', () => {
  for (const target of ['C:\\Windows\\System32\\cmd.exe', '/usr/bin/rm', 'calc.exe', 'not a url', '']) {
    assert.equal(isAllowedOpenTarget(target), false, `${target} 应被拒绝`)
  }
})

test('open 类：拒绝控制字符与超长输入', () => {
  assert.equal(isAllowedOpenTarget('https://x.test/\r\nHost: evil'), false)
  assert.equal(isAllowedOpenTarget('https://x.test/\u0000'), false)
  assert.equal(isAllowedOpenTarget(`https://x.test/${'a'.repeat(2100)}`), false)
  assert.equal(isAllowedOpenTarget(undefined), false)
  assert.equal(isAllowedOpenTarget(42), false)
})

// ── exec 类：allowlist ────────────────────────────────────────────────────────

test('exec 类：allowlist 为空时放行任意可执行文件', () => {
  assert.equal(isAllowedExecTarget('C:\\Program Files\\Foo\\foo.exe', []), true)
  assert.equal(isAllowedExecTarget('code', []), true)
})

test('exec 类：allowlist 非空时只放行名单内（含基名与全路径两种写法）', () => {
  const allowlist = ['code.exe', 'C:\\Program Files\\Spotify\\Spotify.exe']
  assert.equal(isAllowedExecTarget('code.exe', allowlist), true)
  assert.equal(isAllowedExecTarget('C:\\Program Files\\Microsoft VS Code\\code.exe', allowlist), true)
  assert.equal(isAllowedExecTarget('C:\\Program Files\\Spotify\\Spotify.exe', allowlist), true)
  assert.equal(isAllowedExecTarget('C:\\Windows\\System32\\cmd.exe', allowlist), false)
  // 不能靠后缀绕过：`evil-code.exe` 不该因为以 `code.exe` 结尾而放行。
  assert.equal(isAllowedExecTarget('C:\\tmp\\evil-code.exe', allowlist), false)
})

test('exec 类：拒绝控制字符、空值与超长输入', () => {
  assert.equal(isAllowedExecTarget('foo\r\nbar', []), false)
  assert.equal(isAllowedExecTarget('   ', []), false)
  assert.equal(isAllowedExecTarget(`C:\\${'a'.repeat(1100)}`, []), false)
  assert.equal(isAllowedExecTarget(null, []), false)
})

test('exec 参数：只接受有界的普通字符串数组', () => {
  assert.equal(isAllowedArgs([]), true)
  assert.equal(isAllowedArgs(['--profile', 'default']), true)
  assert.equal(isAllowedArgs('--x'), false)
  assert.equal(isAllowedArgs([1]), false)
  assert.equal(isAllowedArgs(['ok', 'bad\narg']), false)
  assert.equal(isAllowedArgs(Array.from({ length: 33 }, () => 'x')), false)
  assert.equal(isAllowedArgs(['a'.repeat(513)]), false)
})

// ── 请求体校验 ────────────────────────────────────────────────────────────────

test('请求体：非对象或未知 action 被拒绝', () => {
  assert.equal(parseLaunchRequest(null).ok, false)
  assert.equal(parseLaunchRequest([]).ok, false)
  assert.equal(parseLaunchRequest('x').ok, false)
  assert.equal(parseLaunchRequest({ action: 'rm-rf' }).ok, false)
  assert.equal(parseLaunchRequest({}).ok, false)
})

test('请求体：open 走 scheme 校验，目标会被 trim', () => {
  const ok = parseLaunchRequest({ action: 'open', target: '  steam://run/730  ' })
  assert.equal(ok.ok, true)
  assert.equal(ok.action, 'open')
  assert.equal(ok.target, 'steam://run/730')

  const bad = parseLaunchRequest({ action: 'open', target: 'file:///C:/Windows/notepad.exe' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /scheme/)
})

test('请求体：exec 只做结构校验，不判 allowlist（那是 authorizeExec 的职责）', () => {
  // 这一层只回答「形状对不对」。allowlist 的判断必须留给 authorizeExec —— 它还要看
  // 运行时信任集合，在这里拦掉就会让「面板里选过的路径」永远走不通。
  const parsed = parseLaunchRequest(
    { action: 'exec', target: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'whoami'] },
    { execAllowlist: ['code.exe'] },
  )
  assert.equal(parsed.ok, true)
  assert.equal(parsed.target, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(parsed.args, ['/c', 'whoami'])
  assert.equal(parsed.userChosen, false)

  // 形状不合法的仍然要拒。
  assert.equal(parseLaunchRequest({ action: 'exec', target: '' }).ok, false)
  assert.equal(parseLaunchRequest({ action: 'exec' }).ok, false)
  assert.equal(parseLaunchRequest({ action: 'exec', target: 'a.exe', args: 'nope' }).ok, false)
})

test('授权：allowlist 命中、userChosen 豁免、信任集合、以及默认拒绝', () => {
  const allowlist = ['code.exe']

  // 命中静态名单。
  assert.deepEqual(
    authorizeExec({ target: 'code.exe', userChosen: false, execAllowlist: allowlist, trustPanelPicked: true, trusted: new ExecTrustSet() }),
    { ok: true, remembered: false },
  )

  // 名单外 + 自动触发 -> 拒。
  const denied = authorizeExec({
    target: 'C:\\Windows\\System32\\cmd.exe', userChosen: false,
    execAllowlist: allowlist, trustPanelPicked: true, trusted: new ExecTrustSet(),
  })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /execAllowlist/)

  // 名单外 + 人选的 + 开关打开 -> 放行并记住。
  const trusted = new ExecTrustSet()
  const first = authorizeExec({
    target: 'C:\\Games\\Foo\\foo.exe', userChosen: true,
    execAllowlist: allowlist, trustPanelPicked: true, trusted,
  })
  assert.deepEqual(first, { ok: true, remembered: true })
  assert.equal(trusted.size, 1)

  // 记住之后，不带 userChosen 也放行。
  assert.deepEqual(
    authorizeExec({ target: 'c:/games/foo/FOO.EXE', userChosen: false, execAllowlist: allowlist, trustPanelPicked: true, trusted }),
    { ok: true, remembered: false },
    '路径比较应忽略大小写与斜杠方向',
  )

  // 同一路径再选一次不算新增。
  assert.equal(trusted.add('C:\\Games\\Foo\\foo.exe'), false)
  assert.equal(trusted.size, 1)

  // 开关关掉 -> userChosen 也拿不到豁免。
  const strict = authorizeExec({
    target: 'C:\\Games\\Bar\\bar.exe', userChosen: true,
    execAllowlist: allowlist, trustPanelPicked: false, trusted: new ExecTrustSet(),
  })
  assert.equal(strict.ok, false)

  // 名单为空 = 部署者显式收窄掉了，一律放行。
  assert.deepEqual(
    authorizeExec({ target: 'anything.exe', userChosen: false, execAllowlist: [], trustPanelPicked: true, trusted: new ExecTrustSet() }),
    { ok: true, remembered: false },
  )
})

test('请求体：exec 省略 args 时等价于空参数', () => {
  const parsed = parseLaunchRequest({ action: 'exec', target: 'foo.exe' }, { execAllowlist: [] })
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.args, [])
})
