# Herdr mods

三个可独立安装的原生 [Herdr](https://herdr.dev/) mod，使用 gpui-kit / gpui-base / herdr API。每个一级目录都是符合 Herdr 分享规范的完整包。

| Mod | 功能 | 文档 |
| --- | --- | --- |
| Agent profiles | 管理 agent 启动参数、保存命名配置、拖动排序与快捷启动 | [安装与使用](agent-profiles/README.md) · [构建说明](agent-profiles/RECIPE.md) |
| SFTP | SSH 连接、本地/远程双栏文件浏览、上传下载和传输队列 | [安装与使用](sftp/README.md) · [构建说明](sftp/RECIPE.md) |
| 系统状态 | 当前 space 所在机器的系统指标，以及独立的本机文件浏览器 | [安装与使用](system-status/README.md) · [构建说明](system-status/RECIPE.md) |

## 目录

```text
herdr-mods/
├── agent-profiles/
│   ├── README.md
│   ├── RECIPE.md
│   ├── preview.png
│   └── mods/agent-profiles/     # 运行代码、图标和测试
├── sftp/
│   ├── README.md
│   ├── RECIPE.md
│   ├── preview.png
│   ├── mods/sftp/               # 运行代码、图标和 Python 后端
│   ├── tests/
│   ├── requirements.txt
│   ├── install.sh
│   └── install-launcher.py      # 可选的个人布局入口
├── system-status/
│   ├── README.md
│   ├── RECIPE.md
│   ├── preview.png
│   └── mods/system-status/      # 运行代码、图标、手写类型和测试
├── scripts/                    # 仓库级检查和 Python 测试入口
├── CONTRIBUTING.md
└── package.json
```

## 安装

先阅读目标包的 README、RECIPE 和源码。只复制包里的 `mods/<名称>/` 到 `${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/`；README、RECIPE、预览图和测试环境无需放进 app home。SFTP 请使用其安装脚本安装 Python 依赖。

例如，从仓库根目录安装 Agent profiles（Bash）：

```bash
(
  set -e
  app_dir=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
  target="$app_dir/mods/agent-profiles"
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "已有同名 mod，请先使用新名称并调整包内引用：$target" >&2
    exit 1
  fi
  mkdir -p "$app_dir/mods"
  cp -R agent-profiles/mods/agent-profiles "$target"
  herdr-app check "$target"
)
herdr-app do mod.open --name agent-profiles
```

不要覆盖已有 mod。改名时同时更新自打开的 mod 名和 `mods/<名称>/` 资源路径。资源目录应复制到 app home 内，跨 app home 的符号链接可能被资源加载器拒绝。三个 mod 均以 `place: none` 安装；系统状态的推荐用法是添加到个人布局，见其 README。

各 mod 的外部访问范围：

- **Agent profiles**：读取已安装 agent，读写 app home 的 `programs.json`、`agent-launch-profiles.json` 和共享状态；通过 Herdr 命令启动所选程序。
- **SFTP**：运行 `hc`、Python 和 OpenSSH，读取 SSH 配置及所选目录，连接用户指定的 SSH/SFTP 服务器并传输文件；任务记录写入 app home 的 `data/sftp/`。
- **系统状态**：通过 `hc exec` 在当前机器采集系统信息；文件标签在本机读取目录，并按操作运行复制或移动命令；图表缓存写入 app home 的 `data/system-status/`。

## 开发与验证

需要 Herdr CLI、Node.js 22.15+ 和 Bash。SFTP 的 Python 测试还需要 Python 3、Paramiko；真实协议测试需要本机 OpenSSH `sftp-server`。JavaScript 无需安装 npm 依赖。

```sh
# 一次性准备 SFTP 测试依赖，也可用 uv venv / uv pip install
python3 -m venv sftp/.venv
sftp/.venv/bin/python -m pip install -r sftp/requirements.txt

npm test           # 三个 mod 的 JavaScript 测试，以及 SFTP Python 测试
npm run check      # 分享包必需文件 + 每个 mod 的 herdr-app check
```

可以单独运行 `npm run test:js` 或 `npm run test:python`。已有 Python 环境可通过 `HERDR_MODS_PYTHON=/absolute/path/to/python npm run test:python` 指定。缺少 Paramiko 会失败并提示安装；缺少 `sftp-server` 时协议测试会明确跳过。

`herdr-app check` 仅检查首次加载和即时渲染，不能替代 app 内的异步加载、延迟列表和交互验证。运行时 API 以当前安装的 `AGENTS.md`、`gpui-kit.d.ts`、`herdr.d.ts` 为准；Herdr 自动生成的类型与 jsconfig 不纳入 Git，手写 `types.d.ts` 保留。

更多开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 分享

发布到公开 GitHub 仓库时添加 topic `herdr-mod`。Herdr 支持同一仓库内多个独立包，索引通常在一小时内更新；分享时指向具体包目录。

仓库只存源码、文档、预览和测试。个人配置、连接信息、运行数据、虚拟环境及 `.worktrees/` 留在本机。首次整理时保留的 SFTP 原仓库在 `.worktrees/sftp-origin/`，原开发 worktree 在 `.worktrees/sftp-panel/`；当前包来自提交 `704c2ee`，这些本地备份不随克隆分发。
