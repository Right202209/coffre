# 系统状态

一个原生 Herdr 侧栏，顶部在“概览”和“系统文件”之间切换。概览显示当前 space 所在机器的资源情况；系统文件独立浏览本机目录，支持复制路径、复制和移动文件。

![系统状态](preview.png)

## What you see

推荐面板宽 344 逻辑像素。顶部 33px 标签栏包含两个标签、刷新按钮，以及概览的暂停按钮；绑定布局节点时显示关闭按钮。底部 27px 状态栏，中间区域可以滚动。整体使用当前 `theme()` 的 chrome、foreground、muted、selected、border 和 input 色，正文 11px，指标数字使用 Geist Mono。

概览先显示机器名，然后是 CPU、内存、磁盘、网络四张卡片，两列排列；窄于 260px 时改为单列。每张卡片包含图标、17px 主指标、详情、64px 使用率环和 34px 趋势图。继续向下显示负载、运行时间、系统、内核、交换空间和采集耗时，以及每核负载、磁盘、网络接口和进程内存。各明细最多显示 12 个核心、12 个磁盘、5 个网卡、5 个进程。资源条超过 60% 为黄色，超过 85% 使用主题 blocked 色。

系统文件显示“本机”、路径输入与“前往”，然后是上级、主目录、根目录、隐藏文件切换，以及复制路径、打开目录、复制、移动/改名操作。下方虚拟列表显示名称和大小；文件夹在前，选中条目使用主题选中色。复制或移动时出现目标路径输入、确认与取消按钮。底部显示条目数量、加载状态或操作结果。

## How it behaves

概览跟随当前 space 的机器；指定 `props.space` 时固定绑定。机器加载中、离线、无会话或平台不支持时显示状态；失败后保留已有样本并标记缓存，可以重试。它不呈现 coding agent 的 working、blocked、done、idle 状态，资源条的 blocked 色仅表示高使用率。

默认每约 5 秒采样，支持暂停、恢复和手动刷新。隐藏面板或切换到文件标签后不再发起新的概览采样，已有请求可以完成。多个副本共享同一机器的数据和请求协调状态，切换机器后的旧请求不能覆盖新的数据。连续错误进入退避等待。

文件标签首次打开主目录，之后记住最近成功路径及隐藏文件设置。切换 space、终端或标签不会改变目录、选择或未提交的操作表单。路径支持绝对路径、`~` 及相对当前目录的路径；Enter 或“前往”导航。双击目录或选中后 Enter 打开，方向键选择，Backspace 返回上级。

复制路径使用选中条目完整路径，没有选中时复制当前目录。复制/移动先填写目标再确认，进行中禁用重复提交。已有目标拒绝覆盖；已有目录接收条目，新路径作为新名字。支持普通文件、目录和符号链接，目录复制包括隐藏内容。操作成功后刷新当前目录；加载失败保留上次成功的目录。

标签可通过方向键、Home、End、Enter、Space 操作。面板控制获得焦点时按 r 刷新；Escape 优先取消文件操作表单，否则尝试把键盘交给左侧 pane。隐藏按钮调用绑定节点的 `layout.hide`。

## Built from

一个 `mods/system-status/` 目录，`main.js` 默认导出继承 View 的类，`mod.json` 设置 `place: none` 和 `focusable: true`。个人布局中使用一个 block，推荐 size 344px、min 220px，并把节点 id 通过 `props.node` 传给 mod。无需依赖其他自定义 mod。

- `main.js`、`context.js`：标签、生命周期、机器与可见性判断。
- `coordinator.js`：按机器共享的样本、24 点历史、请求租约与退避。
- `collectors.js`、`protocol.js`、`metrics.js`：系统命令、带边界的十六进制协议和指标解析。
- `ui.js`、`charts.js`、`graphics.js`：卡片、进度条和动态图表 SVG。
- `file-browser.js`、`files.js`：原生输入、虚拟列表、本机目录读取及复制移动。
- `i18n.js`、`types.d.ts`、自带 SVG、`tests/`：中英文文案、手写类型、图标和 Node 测试。

使用 gpui-kit 的 View/div/svg，gpui-base 的 flex、输入状态、虚拟列表和滚动条；Herdr API 包括 `theme`、`props`、`layout`、`focused`、`spaces`、`machines`、`panes`、`shared/setShared`、`hc`、`nextCommand`、`run` 和 `appHome`。命令包括 `layout.hide`、`pane.go`；mod 自己接收 focus、refresh、files、overview 命令。

通过 `hc exec --json --timeout 10 [--on machine] -- sh -c ...` 采集机器状态。Linux 使用 `/proc`、`/etc/os-release`、`ps`、`df` 等；macOS 使用 `top`、`netstat`、`sysctl`、`sw_vers`、`ps`、`df`。文件操作始终调用本机 `hc exec`。动态图表通过 Herdr 的 `fs/promises` 写入 `data/system-status/`，保留有限代数并在关闭时清理。

共享数据包含 `system-status.v1:<机器 JSON>`、`system-status.tab` 和 `system-status.files.browser`。可选 props 为 node、space、visible、pane、language、intervalMs、reducedMotion；自定义 overlay 需要明确传 `visible: true`，布局副本优先传准确的 node。

## Watch out

不能把文件浏览绑定到当前 space 的远程机器；该标签只操作本机。不要因一次失败导航保存无效路径。用户路径通过参数传递，保留 Unicode、空格、引号和换行；协议解析需拒绝不完整或超限输出。

每目录最多 1000 项，文件命令最多运行 30 秒；超时可能已经部分完成，错误提示必须保留这一点。指标支持 Linux/macOS，其他平台提示不可用；没有当前 space 时概览无数据，文件浏览仍然可用。

刷新间隔限制在 5–60 秒，原生动画默认关闭。可见性来自布局节点、pane 或显式 props，不要认为普通 `mod.open` 会自动提供可见性信息。图表写到 data 而不是 mods，避免触发热重载。移动包目录时保留 `mods/system-status/` 资源路径及运行目录内部的相对导入。

预览来自已有隔离窗口的系统文件标签截图，裁剪后只保留面板；不表示概览已经在本次打包中重新做过实时交互验证。

## Done when

1. 从包根目录运行 `herdr-app check mods/system-status` 与 `node --test mods/system-status/tests/*.test.mjs` 均通过。
2. 个人布局中显示指标；切换机器后显示对应状态，暂停、恢复、隐藏及刷新有效。
3. 文件标签第一次进入本机主目录，支持路径导航、选择、隐藏文件和复制路径。
4. 在临时目录中实际复制、移动文件和文件夹，目标已有同名条目时保留原内容。
5. 切换 space 后文件目录、选择和未确认表单保持原样，操作仍在本机执行。
6. 异步加载、虚拟列表、窄面板和键盘交互无运行错误；需要更新预览时从隔离 Herdr 窗口获取真实截图。
