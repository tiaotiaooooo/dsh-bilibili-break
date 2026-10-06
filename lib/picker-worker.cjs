/**
 * 「选择文件」对话框的 COM 子进程入口（Windows）。
 *
 * 从 DSH 自带的 `dsh-host-directory-picker-native/lib/worker.cjs` 改写而来 —— 那套
 * COM vtable 偏移、DPI 处理、UTF-16 读法和取消语义都是验过的，改动只有两处：
 *
 * 1. `IFileOpenDialog::SetOptions` 换成选文件而不是选文件夹；
 * 2. 加 `IFileDialog::SetFileTypes` 把默认筛选器设成可执行文件。
 *
 * 这里刻意用 `.cjs`：它要能在**普通 node**（不是打包运行时、没有 ESM 加载器）里
 * 直接跑，`require`/`module` 比 ESM 稳妥。koffi 是原生 FFI，仍然按需动态加载。
 */

'use strict'

/** 线程 DPI 感知上下文，从好到次：per-monitor-v2 / per-monitor / system-aware。 */
const DPI_AWARENESS_CONTEXTS = [-4, -3, -2]

const COINIT_APARTMENTTHREADED = 2
const CLSCTX_INPROC_SERVER = 1
const SIGDN_FILESYSPATH = -2147123200

/** HRESULT_FROM_WIN32(ERROR_CANCELLED)：用户点了取消。 */
const HRESULT_CANCELLED = -2147023673

/**
 * `FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_FILEMUSTEXIST`。
 * 见 lib/picker.js 里的同一组常量与解释。
 */
const FILE_DIALOG_OPTIONS = 0x1048

/**
 * `IFileOpenDialog` vtable 槽位。
 *
 * IUnknown 0-2、IModalWindow 3、IFileDialog 从 4 起。这些偏移是 Vista 以来冻结的
 * Windows ABI，不是可以随便猜的魔数 —— 但写错会直接崩在原生调用里，所以每个都用
 * 名字标注。
 */
const SLOT_RELEASE = 2
const SLOT_SHOW = 3
const SLOT_SET_FILE_TYPES = 4
const SLOT_SET_OPTIONS = 9
const SLOT_SET_TITLE = 17
const SLOT_GET_RESULT = 20
/** IShellItem::GetDisplayName */
const SLOT_GET_DISPLAY_NAME = 5

/** 默认筛选器：可执行文件优先，另给「所有文件」一条。 */
const FILE_FILTERS = [
  { name: '程序 (*.exe;*.bat;*.cmd;*.com)', spec: '*.exe;*.bat;*.cmd;*.com' },
  { name: '所有文件 (*.*)', spec: '*.*' },
]

/** 把 `xxxxxxxx-....` 形式的 GUID 编成 CoCreateInstance 要的小端 16 字节。 */
function guidBytes(text) {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(text)
  const bytes = Buffer.alloc(16)
  bytes.writeUInt32LE(parseInt(match[1], 16), 0)
  bytes.writeUInt16LE(parseInt(match[2], 16), 4)
  bytes.writeUInt16LE(parseInt(match[3], 16), 6)
  Buffer.from(match[4] + match[5], 'hex').copy(bytes, 8)
  return bytes
}

const CLSID_FILE_OPEN_DIALOG = guidBytes('dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7')
const IID_IFILE_OPEN_DIALOG = guidBytes('d57c7288-d4ad-4768-be02-9d969532d960')

/**
 * 读一个 NUL 结尾的 UTF-16 字符串。
 *
 * koffi 的 `_Out_ void **` 出参给的是裸地址；`koffi.decode(addr, 'str16')` 会把它当
 * 指针再解一层 —— 在真实 Windows 上直接崩。所以这里自己看内存。
 */
function readUtf16(koffi, address) {
  const bytes = Buffer.from(koffi.view(address, 32768))
  let end = 0
  while (end + 1 < bytes.length && bytes[end] !== 0) end += 2
  return bytes.toString('utf16le', 0, end)
}

/** 加载 koffi 并返回这次对话要用的宿主绑定。 */
async function loadBindings() {
  const koffi = (await import('koffi')).default
  const ole32 = koffi.load('ole32.dll')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const pointerSize = koffi.sizeof('void *')

  const coInitializeEx = ole32.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32'])
  const coUninitialize = ole32.func('__stdcall', 'CoUninitialize', 'void', [])
  const coCreateInstance = ole32.func('__stdcall', 'CoCreateInstance', 'int32', [
    'void *', 'void *', 'uint32', 'void *', 'void *',
  ])
  const coTaskMemFree = ole32.func('__stdcall', 'CoTaskMemFree', 'void', ['void *'])
  const getCurrentThreadId = kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', [])

  const protoShow = koffi.proto('int32 __stdcall DshDialogShow(void *self, void *owner)')
  const protoSetOptions = koffi.proto('int32 __stdcall DshDialogSetOptions(void *self, uint32 options)')
  const protoSetTitle = koffi.proto('int32 __stdcall DshDialogSetTitle(void *self, str16 title)')
  const protoSetFileTypes = koffi.proto('int32 __stdcall DshDialogSetFileTypes(void *self, uint32 count, void *specs)')
  const protoGetResult = koffi.proto('int32 __stdcall DshDialogGetResult(void *self, _Out_ void **item)')
  const protoGetDisplayName = koffi.proto('int32 __stdcall DshItemGetDisplayName(void *self, int32 form, _Out_ void **name)')
  const protoRelease = koffi.proto('uint32 __stdcall DshComRelease(void *self)')

  /** 把 COM 对象 `self` 的 vtable 第 `slot` 槽绑成一个可调用函数。 */
  const method = (self, slot, proto) => {
    const vtable = koffi.decode(self, 'void *')
    const fn = koffi.decode(vtable, slot * pointerSize, 'void *')
    return (...args) => koffi.call(fn, proto, self, ...args)
  }

  /**
   * 把筛选器列表编成 `COMDLG_FILTERSPEC[]`。
   *
   * 结构体是两个 `LPCWSTR`，所以这里分配 2 * 指针大小 * 条数 的一段内存，逐个写入
   * UTF-16 字符串地址。`koffi.alloc` 出来的内存在 JS 侧持有引用，只要这个 Buffer
   * 活到 Show 返回之后就没问题 —— 这里由调用方把返回值一直拿着。
   */
  const encodeFileFilters = (filters) => {
    const memory = koffi.alloc('void *', filters.length * 2)
    filters.forEach((filter, index) => {
      koffi.encode(memory, index * 2 * pointerSize, 'void *', koffi.as(filter.name, 'str16'))
      koffi.encode(memory, (index * 2 + 1) * pointerSize, 'void *', koffi.as(filter.spec, 'str16'))
    })
    return memory
  }

  return {
    setThreadDpiAwareness: () => {
      let setContext
      try {
        setContext = user32.func('__stdcall', 'SetThreadDpiAwarenessContext', 'void *', ['intptr'])
      } catch {
        return
      }
      for (const context of DPI_AWARENESS_CONTEXTS) if (setContext(context) !== null) return
    },
    coInitializeSta: () => coInitializeEx(null, COINIT_APARTMENTTHREADED),
    coUninitialize: () => { coUninitialize() },
    currentThreadId: () => getCurrentThreadId(),
    createFileDialog: (filters) => {
      const out = Buffer.alloc(pointerSize)
      const created = coCreateInstance(CLSID_FILE_OPEN_DIALOG, null, CLSCTX_INPROC_SERVER, IID_IFILE_OPEN_DIALOG, out)
      if (created < 0) throw new Error(`CoCreateInstance(FileOpenDialog) failed: HRESULT 0x${(created >>> 0).toString(16)}`)
      const dialog = koffi.decode(out, 'void *')
      const filterMemory = filters === undefined ? null : encodeFileFilters(filters)
      return {
        setOptions: (options) => method(dialog, SLOT_SET_OPTIONS, protoSetOptions)(options),
        setTitle: (title) => method(dialog, SLOT_SET_TITLE, protoSetTitle)(title),
        setFileTypes: (count) => {
          if (filterMemory === null) return 0
          return method(dialog, SLOT_SET_FILE_TYPES, protoSetFileTypes)(count, filterMemory)
        },
        show: () => method(dialog, SLOT_SHOW, protoShow)(null),
        resultPath: () => {
          const itemOut = [null]
          const gotItem = method(dialog, SLOT_GET_RESULT, protoGetResult)(itemOut)
          if (gotItem < 0) return { hr: gotItem }
          const item = itemOut[0]
          try {
            const nameOut = [null]
            const gotName = method(item, SLOT_GET_DISPLAY_NAME, protoGetDisplayName)(SIGDN_FILESYSPATH, nameOut)
            if (gotName < 0) return { hr: gotName }
            const path = readUtf16(koffi, nameOut[0])
            coTaskMemFree(nameOut[0])
            return { hr: gotName, path }
          } finally {
            method(item, SLOT_RELEASE, protoRelease)()
          }
        },
        release: () => { method(dialog, SLOT_RELEASE, protoRelease)() },
      }
    },
  }
}

/** HRESULT 失败就抛，成功原样返回。 */
function check(hr, what) {
  if (hr < 0) throw new Error(`${what} failed: HRESULT 0x${(hr >>> 0).toString(16)}`)
  return hr
}

/**
 * 在调用线程上跑完一次模态选择：DPI、STA 初始化、建对话、Show、取结果，
 * 每条路径都保证释放对话对象。
 * @returns {string | null} 选中的路径；取消时 null。
 */
function runFileDialog(bindings, title, onShowing) {
  bindings.setThreadDpiAwareness()
  check(bindings.coInitializeSta(), 'CoInitializeEx')
  try {
    const dialog = bindings.createFileDialog(FILE_FILTERS)
    try {
      check(dialog.setFileTypes(FILE_FILTERS.length), 'SetFileTypes')
      check(dialog.setOptions(FILE_DIALOG_OPTIONS), 'SetOptions')
      check(dialog.setTitle(title), 'SetTitle')
      onShowing(bindings.currentThreadId())
      const shown = dialog.show()
      if (shown === HRESULT_CANCELLED) return null
      check(shown, 'Show')
      const result = dialog.resultPath()
      check(result.hr, 'GetResult')
      return result.path
    } finally {
      dialog.release()
    }
  } finally {
    bindings.coUninitialize()
  }
}

// ── 子进程入口 ──────────────────────────────────────────────────────────────

const title = process.env.DSH_PICK_TITLE || '选择要启动的程序'

if (process.send === undefined) {
  throw new Error('picker-worker must run as a child process with an IPC channel')
}

const post = (message) => {
  process.send(message, () => {
    if (process.connected) process.disconnect()
  })
}

process.on('disconnect', () => process.exit(0))

;(async () => {
  try {
    const path = runFileDialog(await loadBindings(), title, (threadId) => {
      // 驱动侧只把它当通知；关闭对话框走 kill 这个进程。
      process.send({ kind: 'showing', threadId })
    })
    post({ kind: 'done', path })
  } catch (error) {
    post({ kind: 'error', message: error instanceof Error ? (error.stack ?? error.message) : String(error) })
  }
})()
