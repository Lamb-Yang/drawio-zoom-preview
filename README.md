# Drawio Zoom Preview

为 [Drawio](https://github.com/doge-liang/obsidian-drawio)（doge-liang/obsidian-drawio）插件提供**放大预览**能力的伴随插件。

## 为什么需要它

Drawio 插件的预览（`![[xxx.drawio]]` 嵌入、代码块、只读文件视图）是**静态 SVG**——这是原插件的刻意设计（渲染后丢弃 drawio 的交互层以换取稳定与离线）。后果是：较大的流程图在笔记里只能看到缩略效果，想看细节必须点进编辑器。

本插件补上这块缺口：**不修改原插件任何文件**，给每个预览挂一个放大镜按钮，点击打开可缩放、可平移的全屏灯箱。

## 功能

- 🔍 悬停预览 → 右上角浮现操作按钮组（触屏设备常驻显示）：
  - **放大镜**：打开缩放灯箱
  - **↗**：用系统默认应用打开图表文件（仅桌面端；代码块无对应文件，不显示）
- 🖱️ 灯箱内交互：
  - **滚轮缩放**（以光标位置为锚点，放大不跑偏）
  - **拖拽平移**
  - **双击**复位到"适应窗口"
  - **Esc / ✕ / 点击遮罩**关闭
  - 移动端支持**双指捏合**缩放
- 📄 **多页图表**：灯箱顶部 `‹ 2 / 5 · 页名 ›` 翻页
  - 当前页直接克隆预览 SVG，秒开
  - 其他页借助 Drawio 插件已加载的 drawio 官方 GraphViewer 运行时离屏渲染
  - 渲染结果按"文件路径 + 修改时间"缓存，文件修改后自动失效
- 🎯 打开时跟随宿主预览当前显示的页码
- 🛡️ 对预览 SVG 做轻量消毒（剔除 script / on* 事件 / javascript: 链接）

## 支持的预览类型

| 场景 | 放大灯箱 | 多页翻页 | 默认应用打开 |
| --- | --- | --- | --- |
| `![[xxx.drawio]]` 嵌入（阅读/实时预览） | ✅ | ✅ | ✅ |
| ` ```drawio ` 代码块 | ✅ | ✅（阅读模式；实时预览下可能降级为单页） | ❌（无对应文件） |
| `.drawio` 只读文件视图 | ✅ | ✅ | ✅ |
| `.drawio.svg` / `.drawio.png` 双格式嵌入 | ✅ | ❌（降级为单页放大） | ✅（打开的是图片文件） |

拿不到源 XML 时一律优雅降级为"单页放大"，不影响基本使用。

## 安装

本插件为本地插件，随 vault 分发：

1. 确认 `.obsidian/plugins/drawio-zoom-preview/` 下有 `manifest.json`、`main.js`、`styles.css`
2. Obsidian → 设置 → 第三方插件 → 启用 **Drawio Zoom Preview**
3. 无需任何配置项

## 操作说明

1. 打开含 drawio 预览的笔记
2. 鼠标悬停在预览上，点击右上角按钮：
   - 🔍 打开灯箱，默认"适应窗口"，滚轮放大即可看细节
   - ↗ 直接用系统默认应用打开 `.drawio` 文件（如 drawio 桌面版）
3. 灯箱工具栏同样提供 ↗ 按钮，看细节时可直接跳转外部应用

> 点击预览本体仍然是原插件的行为（打开编辑器/外部应用），两者互不冲突。
> ↗ 按钮调用 Obsidian 原生 `openWithDefaultApp`，与原 Drawio 插件"Preview click action: 默认应用"行为一致。

## 技术说明

- **零侵入**：通过 `MutationObserver` 监听渲染产物（`.drawio-embed` / `.drawio-codeblock` / `.drawio-preview-file-view`），原插件重渲染后会自动补挂按钮
- **不重新渲染当前页**：直接克隆原插件已渲染、已消毒的 SVG，视觉效果与预览完全一致
- **多页渲染**：复用原插件加载到 `window.GraphViewer` 的 drawio 官方查看器运行时，参数与原插件 ViewerRenderer 保持一致（`nav/lightbox/toolbar` 关闭、`check-visible-state` 关闭、跟随深色模式）
- 灯箱基于 Obsidian `Modal`，仅使用跨版本稳定的 API（不依赖 `Modal` 的 Component 生命周期方法）

## 故障排查

插件内置诊断机制：

- 打开失败时，右下角提示会包含**出错阶段与具体错误**（如 `phase=vault.read(embed): ...`）
- 若错误发生在弹窗内部，弹窗内会直接以红字显示错误详情

如需更详细的堆栈：`Cmd/Ctrl + Option/Shift + I` 打开开发者工具 → Console，查找 `drawio-zoom-preview:` 前缀的报错。

已知边界情况：

- Canvas 画布节点内的嵌入可能解析不到源文件 → 降级为单页
- 灯箱内图中链接不可点击（避免与拖拽冲突），需要跳转请进编辑器
- 缩放范围：适应窗口比例的 0.1 倍 ~ 64 倍

## 未来

Drawio 插件官方 0.6.0 路线图已包含"预览缩放与平移"（P1）。届时官方功能上线后，可直接禁用本插件，二者互不冲突。

## 文件清单

```text
drawio-zoom-preview/
├── manifest.json   # 插件声明
├── main.js         # 核心逻辑（约 700 行原生 JS，无构建步骤）
├── styles.css      # 按钮与灯箱样式
└── README.md       # 本文件
```
