# 系统状态

一个原生 [Herdr](https://herdr.dev/) 侧栏。“概览”显示当前 space 所在机器的系统指标；旁边的“系统文件”浏览对应 machine 的文件树，并为每台机器保留浏览位置。支持树状展开、拖放移动、右键菜单、复制路径及复制／改名。

![系统状态：系统文件标签](preview.png)

预览来自隔离 Herdr 窗口，展示文件树和右键菜单。

## 安装与打开

需要 Herdr app、herdr-core，以及 Linux 或 macOS 的系统命令；远程 machine 需已在 Herdr 中注册并可连接。先阅读 [RECIPE.md](RECIPE.md) 和 [mod 源码](mods/system-status/)。该 mod 通过 `hc exec` 在所选机器运行只读系统采集命令；系统文件标签在对应机器读取目录，按用户操作运行 `cp` / `mv`；动态 SVG 缓存写入 app home 的 `data/system-status/`。

从仓库根目录运行（Bash）：

```bash
(
  set -e
  app_dir=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
  target="$app_dir/mods/system-status"
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "已有同名 mod，请先改名并调整包内引用：$target" >&2
    exit 1
  fi
  mkdir -p "$app_dir/mods"
  cp -R system-status/mods/system-status "$target"
  herdr-app check "$target"
)
```

`mod.json` 使用 `place: none`，安装后不会自动停靠。若正在使用官方布局，先复制：

```sh
herdr-app do layout.clone '{"name":"main","as":"my-layout"}'
```

在个人布局的 row 中加入下面的 block；`props.node` 必须对应本 block 的 id，用于判断可见性和隐藏面板。已有个人布局可直接使用，不必再次复制。

```json
{
  "id": "system-status-panel",
  "type": "block",
  "size": { "px": 344 },
  "min": 220,
  "content": {
    "mod": "system-status",
    "props": { "node": "system-status-panel", "language": "zh" }
  }
}
```

也可由另一个 mod 以 overlay 打开，显式传入 `props: {visible: true}`。普通 `mod.open` 没有可见性参数，适合先查看界面；要采集概览数据，请采用上面的布局或 overlay 集成。

## 配置

在布局 block 的 `content.props` 或打开 overlay 时的 `props` 中设置：

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `node` | 未设置 | 对应布局 block 的 id，用于判断面板可见性及显示隐藏按钮。布局集成推荐设置。 |
| `space` | 当前 space | 固定到指定 space 的 machine；同时影响概览和文件树。 |
| `language` | `"zh"` | 中文；设为 `"en"` 使用英文。 |
| `intervalMs` | `5000` | 概览采样间隔，限制在 5000–60000 毫秒；文件树仍按需刷新。 |
| `reducedMotion` | `true` | 默认减少动画；设为 `false` 启用概览资源条过渡。 |
| `visible` | 自动判断 | 显式指定可见性，覆盖布局／pane 判断；overlay 集成使用 `true`。 |
| `pane` | 未设置 | 作为 pane 集成时，用指定 pane 的 id 判断是否处于当前标签及缩放视图。 |

## 概览

- 显示 CPU、内存、磁盘、网络四组卡片、使用率环和最近 24 次采样趋势，以及负载、运行时间、系统、内核、交换空间和采集耗时。
- 跟随当前 space 的机器；可通过 `props.space` 固定到一个 space。没有 space 时显示无会话状态；无法连接或不支持的平台显示相应提示。
- 默认每约 5 秒采集一次，可通过 `props.intervalMs` 调整到 5000–60000 毫秒。多副本共享采集结果，面板隐藏、暂停或切到文件标签时停止请求新的概览采样。
- 支持刷新、暂停和恢复；有 `props.node` 时可隐藏面板。中文为默认语言，`props.language: "en"` 切为英文。默认减少动画，`props.reducedMotion: false` 启用资源条过渡。

## 系统文件

- 每台 machine 首次打开主目录，分别保存最近成功打开的目录和隐藏文件设置；重启后恢复目录和设置。
- 文件树只随 machine 切换；同一 machine 内切换终端、会话或 space，浏览目录、展开状态、选中项、滚动位置及未提交的操作表单保持不变。面板存续期间切回已访问的 machine，会恢复它的文件树位置。
- 复制、移动及分支读取在文件树所属 machine 执行。切换 machine 清除未提交表单和拖动；已提交操作继续在原机器完成，切回后更新目录。远程断线时禁用操作，恢复连接后读取原目录。
- 输入目录路径后按 Enter 或点击“前往”。支持绝对路径、`~` 和相对当前浏览根目录的路径；也可用工具栏的上级、主目录、根目录图标按钮导航。工具栏图标悬停显示名称，隐藏文件开关开启时高亮。
- 文件树按需读取子目录：点击箭头、双击目录或按 Enter 展开／收起。上下键选择，左右键展开／收起或移到父子条目，Backspace 切换到上级浏览目录。刷新保留已展开路径。
- 将文件或文件夹拖到目标文件夹上，目标高亮后松开即可移动；也可拖到树顶部显示当前目录名的标题行。拖动时底部状态栏显示目标。不会移入自身或子目录，也不会覆盖同名目标。移出面板或按 Esc 取消拖动。
- 右键文件／文件夹显示复制路径、复制、移动／改名、刷新等操作，并在右侧标出对应快捷键；目录还可展开／收起或设为浏览根目录。菜单可用上下键、Enter 和 Esc 操作。
- “复制路径”复制选中条目的完整路径；未选中时复制当前目录路径。
- “复制…”执行 `cp`，“移动 / 改名…”执行 `mv`。填写目标路径后确认：已有目录接收条目，新路径指定新名称。已有同名目标会报错，不覆盖。操作表单中的相对目标路径以源条目所在目录为基准。
- 支持普通文件、目录和符号链接；目录复制包含隐藏文件，保留符号链接。
- 目录按需读取，用右上角刷新按钮更新；操作完成后自动刷新。每个目录最多读取 1000 项，整棵树最多显示 5000 行；深度超过 32 层或符号链接形成祖先循环时停止展开。只绘制可见行，支持滚轮和拖动滚动条。

文件命令支持 Linux 和 macOS，遵循当前用户权限。命令超过 30 秒会提示检查是否已部分完成。

## 浏览位置与保存范围

| 场景 | 文件树行为 |
| --- | --- |
| 同一 machine 内切换终端、会话或 space | 保留目录、展开状态、选中项、滚动位置及未提交的操作表单。 |
| 切换 machine 后再切回 | 恢复该机器的文件树位置；未提交的表单、右键菜单和拖动已取消。 |
| 切到“概览”或隐藏面板，再显示文件树 | 保留浏览位置和未提交表单；拖动和右键菜单取消。 |
| 重启应用或 mod 热重载 | 恢复每台机器最近成功打开的目录和隐藏文件设置；展开、选中及滚动位置重新开始。 |
| 远程连接断开 | 保留已显示的目录，禁用文件操作；连接恢复后刷新原目录。 |
| 没有当前 space | 概览显示无会话；文件树可浏览本机。 |

最近目录和隐藏文件设置保存在 Herdr shared state；展开、选中和滚动位置保存在每个面板副本的内存中。文件树中的复制／移动只在当前 machine 内执行；跨机器上传、下载请使用仓库中的 [SFTP mod](../sftp/README.md)。

## 快捷键

以下文件操作快捷键在文件树获得焦点时生效；在输入框中输入文字不触发文件树快捷键。

| 按键 | 操作 |
| --- | --- |
| `↑` / `↓`、`Home` / `End` | 选择上一项／下一项或首项／末项。 |
| `→` / `←` | 展开／收起目录，或移到子项／父项。 |
| `Enter` | 展开／收起选中的目录。 |
| `Backspace` | 将上级目录设为浏览根目录。 |
| `Ctrl+C` / `Cmd+C` | 复制选中项路径；未选中时复制当前目录路径。 |
| `F2` | 打开移动／改名表单。 |
| `r` | 刷新；面板顶部控制获得焦点时也可使用。 |
| `Esc` | 优先取消菜单、拖动或未执行的操作表单，否则尝试将焦点交给左侧 pane。 |

右键菜单支持 `↑` / `↓` 选择、`Enter` 执行和 `Esc` 关闭。顶部标签获得焦点时，使用 `←` / `→` 或 `Home` / `End` 切换“概览”和“系统文件”。

## 验证

从本包根目录 `system-status/` 运行（Node.js 22.15+）：

```sh
node --test mods/system-status/tests/*.test.mjs
herdr-app check mods/system-status
```

`herdr-app check` 不覆盖输入和异步加载后的交互；还需在 app 内验证路径输入、树的展开收起、右键菜单、文件与文件夹拖放、长列表滚动，以及同一 machine 内切换 space 后位置保持不变、切换 machine 后显示对应文件树并恢复各自的位置。

已在 Linux 原生 Herdr 窗口中验证本机与远程 machine 来回切换、同一 machine 内切换标签和 space，以及各自的目录、展开状态、选中项和滚动位置恢复。自动化测试还覆盖延迟响应、后台操作、重复提交和连接中断；macOS 命令分支仍需在对应系统上验证。

## 参考与致谢

感谢 [Herdr](https://herdr.dev/) 与 [gpui-kit](https://gpui-kit.com/) 的作者和维护者：Herdr 提供机器连接、终端与 mod API，gpui-kit 提供原生 GPUI 界面组件和布局能力。

开发时以当前 Herdr app home 中的 `AGENTS.md`、`gpui-kit.d.ts` 和 `herdr.d.ts` 为 API 依据；Herdr 随附的示例 mod 也可作为原生交互参考。本 mod 的结构和行为见 [RECIPE.md](RECIPE.md)，仓库的其他参考来源见 [总览中的致谢](../README.md#参考与致谢)。

## 卸载

先删除个人布局中对应的 block，再移除 app home 的 `mods/system-status/`。最近目录、隐藏文件设置和标签选择属于 shared state，删除 mod 目录不会自动清除这些设置。
