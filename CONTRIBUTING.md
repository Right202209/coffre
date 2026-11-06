# 开发约定

## 包结构

每个 mod 使用独立的一级目录，包含 `README.md`、`RECIPE.md`、真实原生截图 `preview.png` 和 `mods/<名称>/`。运行目录必须有 `main.js` 与 `mod.json`，相对导入、图标等依赖放在该目录内。新增包后更新根 README 和测试入口。

`RECIPE.md` 按 Herdr 规范说明 What you see、How it behaves、Built from、Watch out、Done when，使另一个开发者能从空目录重建实际功能。描述已有行为，明确尚未支持的功能。

## Herdr 运行规则

先读当前 app home 的 `AGENTS.md`。默认路径是 `~/.config/herdr-app/AGENTS.md`，设置 `HERDR_APP_HOME` 时使用对应目录。当前生成的 `gpui-kit.d.ts` 与 `herdr.d.ts` 是 API 依据，不修改或提交这些生成文件。

- 原生 GPUI 没有 DOM、HTML、CSS 或 Node API。`main.js` 默认导出 `View` 子类。
- 每个回调使用其自己的 `cx`，不保存 context 后续复用；异步任务用 `cx.spawn`，定时数据更新用 `cx.timer`。
- 不使用 `setTimeout`、`setInterval` 或顶层 await。动画使用原生 frames、spin、loop、transition。
- 使用 `theme()` 色彩。图标路径相对于 app home，例如 `mods/system-status/cpu.svg`。
- 不编辑官方 mod、布局、frame 或 app 自动维护的状态文件。修改官方结构前用 `mod.clone` / `layout.clone` 创建个人副本。
- 安装前说明程序执行、网络与文件访问。遇到同名 mod 采用新名字并更新引用；不覆盖已有文件或用户快捷键。

## 验证

在仓库根目录运行 `npm test` 和 `npm run check`。每次修改 mod 后都运行该 mod 的 `herdr-app check <目录>`，全部通过后再验收。

JavaScript 测试使用 Node 原生测试器；Agent profiles 的测试按其既有约定关闭文件隔离。SFTP Python 测试使用本机 OpenSSH SFTP 服务端，不需要外部服务器；环境准备见根 README。测试跳过必须在结果中说明。

UI 或行为变化还须在隔离 app home 中验证：使用独立 core/session，安装 mod 文件，再测试初始画面、异步数据、延迟列表、键盘与指针操作。用 `herdr-app shot` 保存真实窗口画面，必要时裁剪 mod 区域更新 `preview.png`。不要把真实凭证或个人文件内容放进预览。

发布前检查 `git diff --check` 和待提交文件，确保未混入生成的 SDK、虚拟环境、运行状态、认证材料或内部 worktree。保持包可单独复制安装；仓库本身不是 Node 应用，也无需构建产物。
