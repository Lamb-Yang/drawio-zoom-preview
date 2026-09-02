# AGENTS.md

给在本仓库工作的 AI 编码代理（以及新加入的协作者）的指引。项目定位与用户功能见 `README.md`，本文聚焦"怎么正确地改这个仓库"。

## 项目是什么

Obsidian 伴随插件 `drawio-zoom-preview`：为宿主插件 [doge-liang/obsidian-drawio](https://github.com/doge-liang/obsidian-drawio)（插件 id `drawio-editor`）的静态 SVG 预览提供"放大镜按钮 + 全屏灯箱（缩放 / 平移 / 多页翻页 / 用默认应用打开）"。零侵入：不修改宿主任何文件，靠 `MutationObserver` 补挂按钮。

## 技术形态（硬约束）

- **无构建系统**：`main.js` 是手写的原生 CommonJS（`require("obsidian")`），没有 package.json、npm 依赖或打包器。改完用 `node --check main.js` 做语法检查即可。**不要**引入构建步骤或第三方依赖，除非先与仓库所有者确认。
- 运行环境为 Obsidian（Electron），可用现代 JS 语法；API 兼容下限为 `manifest.json` 的 `minAppVersion`（当前 1.4.0）。
- UI 文案与代码注释为中文，新增内容保持一致；提交信息用中文并带类型前缀（`fix:` / `ci:` / `docs:` / `chore:`），正文说明"为什么"。

## 修改前必读：对宿主插件的依赖

本插件依赖宿主的实现细节，改动 DOM 解析相关逻辑前，先到宿主 bundle 里核对（本机位置：测试 vault 的 `.obsidian/plugins/drawio-editor/main.js`，可直接 grep），不要凭空假设：

| 依赖点 | 现状（宿主 0.7.1 已验证） |
| --- | --- |
| 预览容器类名 | `.drawio-embed` / `.drawio-codeblock` / `.drawio-preview-file-view`（`HOST_SEL`），三者均有 `position: relative` |
| 预览 SVG | 容器内 `.drawio-preview`，其 svg 带显式 px 的 `width`/`height`/`viewBox` |
| 多页控件 | `.drawio-page-control span` 文本格式为 `N / M` |
| 查看器运行时 | 宿主把 drawio 官方 `GraphViewer` 暴露为全局函数 |
| 只读文件视图 | 视图 type 为 `drawio-file-view` |
| 交互式预览 | 宿主 ≥0.7.x 通过**改写预览 SVG 的 viewBox** 实现缩放平移（详见下节） |

## 灯箱核心约定（勿破坏）

- 灯箱语义是"整图 + CSS transform 缩放"。`mountSvg` 会把 viewBox 重置为 `0 0 w h`——这是为对抗宿主交互模式的 viewBox 裁剪，**不要删除或绕过**。
- 页面缓存 `pageCache`：key 为文件路径（代码块用内容 hash），stamp 为 `mtime + 主题`；`css-change` 事件时整体清空。缓存中的 SVG 一律视为"宿主克隆，可能被交互模式裁剪"，挂载时统一修复。
- 深色渲染判定用 `isDarkRender(app)`（对齐宿主 `followObsidianTheme` 设置），不要直接读 `theme-dark`，否则宿主关闭"跟随主题"时灯箱内前后页配色不一致。
- Modal 不依赖 Component 生命周期（部分版本没有 `register`），window/document 级监听器必须在 `onClose` 手动移除，新增监听同样照做。
- 已知边界：双格式嵌入（`.drawio.svg` / `.drawio.png`）是宿主渲染的原生 `<img>`，本插件挂不上按钮（README 表格如实记载，属计划中功能而非 bug）。

## 手动验证方式（无自动化测试）

改动后把 `main.js`、`styles.css`、`manifest.json` 复制到测试 vault 的 `.obsidian/plugins/drawio-zoom-preview/`（作者本机为 `/Users/yang/Documents/notebook`），在 Obsidian 中重载插件，覆盖以下场景：

1. 三类预览各验一次：`![[x.drawio]]` 嵌入、` ```drawio ` 代码块、`.drawio` 只读文件视图；
2. 多页文件：翻页、缓存命中（二次翻页秒开）、页码与宿主预览一致；
3. 宿主"预览点击行为"设为 Interactive 后，在预览里缩放/平移，再点放大镜，确认灯箱显示**完整图表**而非裁剪区域；
4. 切换深浅主题后重开灯箱翻页，确认配色一致；
5. 禁用再启用本插件，确认无残留按钮。

## 发布流程（全自动，勿手动创建 Release）

1. 修改 `manifest.json` 的 `version`——**必须与将来 tag 名完全一致**（Obsidian 更新器依赖二者相等，CI 会校验并拦截不一致）；
2. 合入 `main`；
3. `git tag <版本号> && git push origin <版本号>`；
4. `.github/workflows/release.yml` 自动完成：版本校验 → 维护 `versions.json`（bot 回写 `main`）→ 打包 `<插件名>-<版本>.zip` → 创建 Release 并附上 zip、`main.js`、`manifest.json`、`styles.css`、`versions.json`。

注意：`versions.json` 由 CI 维护，**不要手工编辑**；`main` 有分支保护（禁 force push / 禁删除，对管理员生效），常规 push 与自行合并 PR 不受影响。
