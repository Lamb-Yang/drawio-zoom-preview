/*
 * drawio-zoom-preview —— "Drawio"（doge-liang/obsidian-drawio）插件的伴随扩展。
 *
 * 原理：
 *  - Drawio 插件把 ![[x.drawio]]、```drawio 代码块、.drawio 只读文件视图
 *    渲染成静态 SVG（容器类名分别为 .drawio-embed / .drawio-codeblock /
 *    .drawio-preview-file-view）。
 *  - 本插件不修改原插件，只用 MutationObserver 给这些容器挂一个放大镜按钮。
 *  - 点击按钮打开全屏灯箱：直接克隆当前已渲染的 SVG，用 CSS transform
 *    实现滚轮缩放（以光标为锚点）、拖拽平移、双指捏合、双击复位。
 *  - 多页图表：借助原插件已加载到 window.GraphViewer 的 drawio 官方
 *    查看器运行时，按页重新渲染其它页面并提取 SVG（与原插件的
 *    ViewerRenderer 同样的做法），实现灯箱内翻页。
 */

const { Plugin, Modal, MarkdownView, Notice, Platform } = require("obsidian");

const HOST_SEL = ".drawio-embed, .drawio-codeblock, .drawio-preview-file-view";
const FILE_VIEW_TYPE = "drawio-file-view";

const ZOOM_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>`;

const OPEN_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;

// 用系统默认应用打开图表（桌面端；与原 drawio 插件的 defaultApp 行为一致）
function openWithDefaultApp(app, path) {
	if (typeof app.openWithDefaultApp === "function") {
		app.openWithDefaultApp(path);
	} else {
		new Notice("Drawio 放大预览：当前 Obsidian 版本不支持打开默认应用");
	}
}

/* ---------------- XML 辅助（与原插件行为保持一致） ---------------- */

// 裸 mxGraphModel 包一层 mxfile，与原插件的 z() 相同
function normalizeXml(raw) {
	const s = (raw || "").trim();
	if (!s) return s;
	if (/<mxfile[\s>]/.test(s)) return s;
	if (/<mxGraphModel[\s>]/.test(s)) {
		return `<mxfile><diagram id="0" name="Page-1">${s}</diagram></mxfile>`;
	}
	return s;
}

// 解析 mxfile 的页面列表（只取 name 用于展示）
function parsePages(xml) {
	const pages = [];
	const re = /<diagram\b([^>]*)>/g;
	let m = re.exec(xml);
	while (m) {
		const attrs = m[1] || "";
		const nameMatch = /\bname="([^"]*)"/.exec(attrs);
		pages.push({ name: nameMatch ? nameMatch[1] : `Page-${pages.length + 1}` });
		m = re.exec(xml);
	}
	return pages;
}

function hashCode(s) {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return String(h >>> 0);
}

// 轻量消毒：剔除脚本标签 / on* 事件 / javascript: 链接（原插件也做了同类处理）
function sanitizeSvg(svg) {
	const badTags = new Set([
		"script",
		"iframe",
		"object",
		"embed",
		"link",
		"meta",
		"base",
	]);
	for (const el of [svg, ...svg.querySelectorAll("*")]) {
		if (el.nodeType !== 1) continue;
		if (badTags.has(el.localName.toLowerCase())) {
			el.remove();
			continue;
		}
		for (const attr of Array.from(el.attributes)) {
			const n = attr.name.toLowerCase();
			const v = attr.value || "";
			if (n.startsWith("on")) {
				el.removeAttribute(attr.name);
			} else if (n === "href" || n === "xlink:href" || n === "src") {
				if (/^\s*(javascript|vbscript):/i.test(v))
					el.removeAttribute(attr.name);
			} else if (n === "style" && /expression\s*\(|javascript:/i.test(v)) {
				el.removeAttribute(attr.name);
			}
		}
	}
	return svg;
}

/* ---------------- 用 window.GraphViewer 渲染指定页 ---------------- */

let offscreenSeq = 0;

function graphViewerAvailable() {
	return (
		typeof window.GraphViewer === "function" &&
		typeof window.GraphViewer.createViewerForElement === "function"
	);
}

// 与宿主 previewOpts()（followObsidianTheme && isDark）对齐的深色判定。
// 宿主关闭"跟随 Obsidian 主题"时其预览固定浅色，离屏渲染的其它页也应
// 保持浅色，否则灯箱内第一页（克隆）与其余页（离屏渲染）配色不一致
function isDarkRender(app) {
	const plugin =
		app.plugins && app.plugins.plugins && app.plugins.plugins["drawio-editor"];
	const follow =
		plugin && plugin.settings
			? plugin.settings.followObsidianTheme !== false
			: true;
	return follow && document.body.classList.contains("theme-dark");
}

function waitForSvg(root, timeoutMs) {
	const now = root.querySelector("svg");
	if (now) return Promise.resolve(now);
	return new Promise((resolve) => {
		let settled = false;
		const observer = new MutationObserver(() => {
			const s = root.querySelector("svg");
			if (s) finish(s);
		});
		const timer = setTimeout(() => finish(null), timeoutMs);
		function finish(v) {
			if (settled) return;
			settled = true;
			observer.disconnect();
			clearTimeout(timer);
			resolve(v);
		}
		observer.observe(root, { childList: true, subtree: true });
	});
}

// 与 drawio 插件的 Oi() 相同：给提取出的 SVG 固定 width/height/viewBox
function extractSvg(liveSvg) {
	const rect = liveSvg.getBoundingClientRect();
	const w = parseFloat(liveSvg.style.minWidth) || rect.width || 0;
	const h = parseFloat(liveSvg.style.minHeight) || rect.height || 0;
	const clone = liveSvg.cloneNode(true);
	if (w > 0 && h > 0) {
		clone.setAttribute("viewBox", `0 0 ${w} ${h}`);
		clone.setAttribute("width", String(w));
		clone.setAttribute("height", String(h));
		for (const p of [
			"width",
			"height",
			"min-width",
			"min-height",
			"position",
			"left",
			"top",
		]) {
			clone.style.removeProperty(p);
		}
	}
	return sanitizeSvg(clone);
}

async function renderPageSvg(xml, pageIndex, dark) {
	if (!graphViewerAvailable()) return null;
	offscreenSeq += 1;
	const host = document.createElement("div");
	host.className = `dzp-offscreen-${offscreenSeq}`;
	host.style.cssText =
		"position:fixed;left:-10000px;top:-10000px;width:1200px;height:800px;overflow:hidden;pointer-events:none;visibility:hidden;";
	const slot = document.createElement("div");
	slot.className = "mxgraph";
	slot.setAttribute(
		"data-mxgraph",
		JSON.stringify({
			highlight: "#0000ff",
			nav: false,
			lightbox: false,
			toolbar: "",
			edit: null,
			"check-visible-state": false,
			"dark-mode": dark ? "auto" : "off",
			page: pageIndex,
			xml: normalizeXml(xml),
		}),
	);
	host.appendChild(slot);
	document.body.appendChild(host);
	try {
		const params = window.urlParams;
		const savedPage = params ? params.page : undefined;
		try {
			window.GraphViewer.createViewerForElement(slot);
		} finally {
			if (params) params.page = savedPage;
		}
		const svg = await waitForSvg(slot, 6000);
		return svg ? extractSvg(svg) : null;
	} catch (err) {
		console.error("drawio-zoom-preview: 渲染页面失败", err);
		return null;
	} finally {
		host.remove();
	}
}

/* ---------------- 页面渲染结果缓存 ---------------- */

const pageCache = new Map(); // key -> { stamp, svgs: Map<number,string> }

function cacheFor(key, stamp) {
	let entry = pageCache.get(key);
	if (!entry || entry.stamp !== stamp) {
		if (pageCache.size >= 40) pageCache.delete(pageCache.keys().next().value);
		entry = { stamp, svgs: new Map() };
		pageCache.set(key, entry);
	}
	return entry.svgs;
}

/* ---------------- 灯箱 ---------------- */

// 快速双击放大镜时避免叠开两层灯箱
let lightboxOpen = false;

class ZoomLightbox extends Modal {
	constructor(app, opts) {
		super(app);
		this.diagramTitle = opts.title || "Drawio diagram";
		this.xml = opts.xml || null; // 多页翻页用；null 表示仅展示当前页克隆
		this.pages = opts.pages || []; // [{name}]
		this.page = Math.min(
			Math.max(opts.initialPage || 0, 0),
			Math.max(this.pages.length - 1, 0),
		);
		this.cache = opts.cache || null; // Map<int, svgHtml>
		this.filePath = opts.filePath || null; // 非 null 时灯箱显示"用默认应用打开"
		this.initialSvgHtml = opts.svgHtml;
		this.state = { scale: 1, x: 0, y: 0 };
		this.fitScale = 1;
		this.isFitted = true;
		this.natural = { w: 0, h: 0 };
		this.pointers = new Map();
		this.lastPinch = null;
		this.rendering = false;
		this.loadingEl = null;
		this.tapSuppressed = false;
		this.lastTap = { t: 0, x: 0, y: 0 };
	}

	onOpen() {
		lightboxOpen = true;
		try {
			this.onOpenInner();
		} catch (err) {
			console.error("drawio-zoom-preview: 灯箱 onOpen 失败", err);
			try {
				this.contentEl.createDiv({
					cls: "dzp-open-error",
					text: `灯箱打开失败：${err && err.message ? err.message : String(err)}`,
				});
			} catch {
				/* 忽略 */
			}
		}
	}

	onOpenInner() {
		const { contentEl, modalEl } = this;
		modalEl.classList.add("dzp-modal");
		contentEl.empty();

		// 顶部工具栏：翻页 | 标题 | 缩放控制
		const bar = contentEl.createDiv({ cls: "dzp-toolbar" });

		this.pagesEl = bar.createDiv({ cls: "dzp-pages" });
		this.prevBtn = this.pagesEl.createEl("button", {
			text: "\u2039",
			attr: { "aria-label": "上一页", title: "上一页" },
		});
		this.pageLabelEl = this.pagesEl.createEl("span", { cls: "dzp-page-label" });
		this.nextBtn = this.pagesEl.createEl("button", {
			text: "\u203a",
			attr: { "aria-label": "下一页", title: "下一页" },
		});
		this.prevBtn.addEventListener("click", () => this.gotoPage(this.page - 1));
		this.nextBtn.addEventListener("click", () => this.gotoPage(this.page + 1));

		bar.createDiv({ cls: "dzp-title", text: this.diagramTitle });

		const controls = bar.createDiv({ cls: "dzp-controls" });
		const mkBtn = (label, text, fn) => {
			const b = controls.createEl("button", {
				text,
				attr: { "aria-label": label, title: label },
			});
			b.addEventListener("click", fn);
			return b;
		};
		mkBtn("缩小", "\u2212", () => this.zoomCenter(1 / 1.25));
		this.percentEl = controls.createEl("span", {
			cls: "dzp-percent",
			text: "100%",
		});
		mkBtn("放大", "+", () => this.zoomCenter(1.25));
		mkBtn("适应窗口", "Fit", () => this.fit());
		if (this.filePath && Platform.isDesktopApp) {
			mkBtn("用默认应用打开", "\u2197", () => {
				openWithDefaultApp(this.app, this.filePath);
			});
		}
		mkBtn("关闭", "\u2715", () => this.close());

		// 画布区
		this.stageEl = contentEl.createDiv({ cls: "dzp-stage" });
		this.canvasEl = this.stageEl.createDiv({ cls: "dzp-canvas" });

		// 底部提示
		contentEl.createDiv({
			cls: "dzp-statusbar",
			text: Platform.isMobile
				? "捏合缩放 · 拖动平移 · 双击复位"
				: "滚轮缩放 · 拖动平移 · 双击复位 · Esc 关闭",
		});

		this.bindStageEvents();
		this.mountSvg(this.initialSvgHtml, true);
		this.updatePageUi();
		// 等布局完成后再计算"适应窗口"
		requestAnimationFrame(() => this.fit());
	}

	onClose() {
		lightboxOpen = false;
		// 部分 Obsidian 版本的 Modal 不是 Component（没有 register），
		// 监听器在 onClose 手动移除
		if (this.resizeHandler) {
			window.removeEventListener("resize", this.resizeHandler);
			this.resizeHandler = null;
		}
		this.pointers.clear();
		this.contentEl.empty();
	}

	/* ---- SVG 装载与视图变换 ---- */

	mountSvg(svgHtml, fitAfter) {
		this.canvasEl.empty();
		const holder = document.createElement("div");
		holder.innerHTML = svgHtml;
		const svg = holder.querySelector("svg");
		if (!svg) return;
		this.canvasEl.appendChild(svg);
		// 带百分号的宽高属性不可直接 parseFloat（"100%" 会变成 100）
		const wa = svg.getAttribute("width");
		const ha = svg.getAttribute("height");
		let w = wa && !/%\s*$/.test(wa) ? parseFloat(wa) || 0 : 0;
		let h = ha && !/%\s*$/.test(ha) ? parseFloat(ha) || 0 : 0;
		if (w > 0 && h > 0) {
			// 灯箱语义是"整图 + CSS transform 缩放"。宿主 0.7.x 交互式预览会把
			// viewBox 改写成缩放/平移后的裁剪区域，克隆过来必须重置回整图坐标系
			svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
		} else {
			const vb = svg.viewBox && svg.viewBox.baseVal;
			if (vb && vb.width > 0) {
				w = vb.width;
				h = vb.height;
			} else {
				const r = svg.getBoundingClientRect();
				w = r.width;
				h = r.height;
			}
		}
		this.natural = { w, h };
		if (fitAfter) this.fit();
	}

	applyTransform() {
		const { scale, x, y } = this.state;
		this.canvasEl.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
		if (this.percentEl) this.percentEl.setText(`${Math.round(scale * 100)}%`);
	}

	fit() {
		const sw = this.stageEl.clientWidth;
		const sh = this.stageEl.clientHeight;
		const { w, h } = this.natural;
		if (!(sw > 0 && sh > 0 && w > 0 && h > 0)) return;
		const s = Math.min(sw / w, sh / h);
		this.fitScale = s;
		this.state = { scale: s, x: (sw - w * s) / 2, y: (sh - h * s) / 2 };
		this.isFitted = true;
		this.applyTransform();
	}

	zoomAt(px, py, k) {
		const s = this.state;
		const min = Math.max(this.fitScale * 0.1, 0.005);
		const max = 64;
		const ns = Math.min(Math.max(s.scale * k, min), max);
		if (ns === s.scale) return;
		const f = ns / s.scale;
		s.x = px - (px - s.x) * f;
		s.y = py - (py - s.y) * f;
		s.scale = ns;
		this.isFitted = false;
		this.applyTransform();
	}

	zoomCenter(k) {
		this.zoomAt(this.stageEl.clientWidth / 2, this.stageEl.clientHeight / 2, k);
	}

	pan(dx, dy) {
		this.state.x += dx;
		this.state.y += dy;
		this.isFitted = false;
		this.applyTransform();
	}

	/* ---- 交互事件 ---- */

	bindStageEvents() {
		const stage = this.stageEl;

		stage.addEventListener(
			"wheel",
			(e) => {
				e.preventDefault();
				const r = stage.getBoundingClientRect();
				this.zoomAt(
					e.clientX - r.left,
					e.clientY - r.top,
					Math.exp(-e.deltaY * 0.0015),
				);
			},
			{ passive: false },
		);

		stage.addEventListener("pointerdown", (e) => {
			if (e.pointerType === "mouse" && e.button !== 0) return;
			stage.setPointerCapture(e.pointerId);
			this.pointers.set(e.pointerId, {
				x: e.clientX,
				y: e.clientY,
				sx: e.clientX,
				sy: e.clientY,
			});
			if (this.pointers.size === 2) {
				this.lastPinch = null;
				this.tapSuppressed = true; // 双指手势不算点按
			}
			stage.classList.add("dzp-grabbing");
		});

		stage.addEventListener("pointermove", (e) => {
			const prev = this.pointers.get(e.pointerId);
			if (!prev) return;
			const cur = { x: e.clientX, y: e.clientY };
			this.pointers.set(e.pointerId, cur);
			if (this.pointers.size === 1) {
				this.pan(cur.x - prev.x, cur.y - prev.y);
			} else if (this.pointers.size === 2) {
				const pts = [...this.pointers.values()];
				const a = pts[0];
				const b = pts[1];
				const dist = Math.hypot(a.x - b.x, a.y - b.y);
				const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
				const r = stage.getBoundingClientRect();
				if (this.lastPinch) {
					if (this.lastPinch.dist > 0) {
						this.zoomAt(
							mid.x - r.left,
							mid.y - r.top,
							dist / this.lastPinch.dist,
						);
					}
					this.pan(mid.x - this.lastPinch.mid.x, mid.y - this.lastPinch.mid.y);
				}
				this.lastPinch = { dist, mid };
			}
		});

		const release = (e) => {
			const start = this.pointers.get(e.pointerId);
			this.pointers.delete(e.pointerId);
			if (this.pointers.size < 2) this.lastPinch = null;
			if (this.pointers.size === 0) {
				stage.classList.remove("dzp-grabbing");
				if (!this.tapSuppressed) this.handleTap(e, start);
				this.tapSuppressed = false;
			}
		};
		stage.addEventListener("pointerup", release);
		stage.addEventListener("pointercancel", release);

		stage.addEventListener("dblclick", (e) => {
			e.preventDefault();
			this.fit();
		});

		// 窗口尺寸变化时，如果用户处于"适应窗口"状态则重新适应
		this.resizeHandler = () => {
			if (this.isFitted) this.fit();
		};
		window.addEventListener("resize", this.resizeHandler);
	}

	// 移动端 WKWebView 不会为双击派发 dblclick，用 pointerup 时间差自行判定
	handleTap(e, start) {
		if (!start || e.pointerType === "mouse") return;
		if (Math.hypot(e.clientX - start.sx, e.clientY - start.sy) > 24) return;
		const now = Date.now();
		const last = this.lastTap;
		if (
			now - last.t < 300 &&
			Math.hypot(e.clientX - last.x, e.clientY - last.y) < 24
		) {
			this.lastTap = { t: 0, x: 0, y: 0 };
			this.fit();
		} else {
			this.lastTap = { t: now, x: e.clientX, y: e.clientY };
		}
	}

	/* ---- 多页翻页 ---- */

	updatePageUi() {
		if (!this.pagesEl) return;
		const multi = this.pages.length > 1;
		this.pagesEl.style.display = multi ? "" : "none";
		if (!multi) return;
		const info = this.pages[this.page] || {};
		const suffix = info.name ? ` · ${info.name}` : "";
		this.pageLabelEl.setText(
			`${this.page + 1} / ${this.pages.length}${suffix}`,
		);
		this.prevBtn.disabled = this.page <= 0 || this.rendering;
		this.nextBtn.disabled =
			this.page >= this.pages.length - 1 || this.rendering;
	}

	setLoading(on) {
		if (on && !this.loadingEl) {
			this.loadingEl = this.stageEl.createDiv({
				cls: "dzp-loading",
				text: "正在渲染…",
			});
		} else if (!on && this.loadingEl) {
			this.loadingEl.remove();
			this.loadingEl = null;
		}
	}

	async gotoPage(idx) {
		if (this.rendering || !this.xml) return;
		if (idx < 0 || idx >= this.pages.length || idx === this.page) return;

		const cached = this.cache ? this.cache.get(idx) : null;
		if (cached) {
			this.page = idx;
			this.updatePageUi();
			this.mountSvg(cached, true);
			return;
		}

		// 先乐观更新页码（标签跟随 + 禁用翻页按钮），渲染失败再回滚，
		// 避免"标签显示新页、画布还是旧页"且无法立即重试
		const prevPage = this.page;
		this.page = idx;
		this.rendering = true;
		this.setLoading(true);
		this.updatePageUi();
		try {
			const svg = await renderPageSvg(this.xml, idx, isDarkRender(this.app));
			if (!this.modalEl.isConnected) return;
			if (svg) {
				const html = svg.outerHTML;
				if (this.cache) this.cache.set(idx, html);
				if (idx === this.page) this.mountSvg(html, true);
			} else {
				this.page = prevPage;
				new Notice("Drawio 放大预览：该页渲染失败");
			}
		} finally {
			this.rendering = false;
			this.setLoading(false);
			this.updatePageUi();
		}
	}
}

/* ---------------- 插件主体 ---------------- */

module.exports = class DrawioZoomPreview extends Plugin {
	onload() {
		document.body.classList.toggle("dzp-touch", Platform.isMobile);

		this.scanTimer = null;
		this.observer = new MutationObserver(() => this.scheduleScan());
		this.observer.observe(document.body, { childList: true, subtree: true });
		this.register(() => this.observer.disconnect());

		// 布局 / 样式变化后再扫一遍（切换标签页、切换编辑/阅读模式等）
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.scheduleScan()),
		);
		this.registerEvent(
			this.app.workspace.on("css-change", () => {
				// 主题/外观变化会改变离屏渲染的配色，已缓存的页全部作废
				pageCache.clear();
				this.scheduleScan();
			}),
		);

		this.scheduleScan();
	}

	onunload() {
		if (this.scanTimer) window.clearTimeout(this.scanTimer);
		document.body.classList.remove("dzp-touch");
		// 移除已挂到各预览上的按钮组，避免禁用后留下不可用的死按钮
		document.querySelectorAll(".dzp-actions").forEach((el) => el.remove());
	}

	scheduleScan() {
		if (this.scanTimer) return;
		this.scanTimer = window.setTimeout(() => {
			this.scanTimer = null;
			this.scanPreviews();
		}, 150);
	}

	scanPreviews() {
		let hosts;
		try {
			hosts = document.querySelectorAll(HOST_SEL);
		} catch {
			return;
		}
		for (const host of hosts) {
			if (!host.isConnected) continue;
			// 原插件重渲染会清空容器（按钮被移除），这里按"按钮组是否存在"补挂
			if (host.querySelector(":scope > .dzp-actions")) continue;
			// 还没渲染出预览（或渲染报错）时不挂按钮
			if (!host.querySelector(".drawio-preview")) continue;
			this.attachButton(host);
		}
	}

	attachButton(host) {
		const actions = document.createElement("div");
		actions.className = "dzp-actions";

		const zoomBtn = document.createElement("button");
		zoomBtn.className = "dzp-btn dzp-zoom-btn";
		zoomBtn.type = "button";
		zoomBtn.setAttribute("aria-label", "放大预览");
		zoomBtn.setAttribute("title", "放大预览");
		zoomBtn.innerHTML = ZOOM_ICON;
		zoomBtn.addEventListener("click", (e) => {
			// 阻止冒泡，避免触发原插件的"点击进编辑器"
			e.preventDefault();
			e.stopPropagation();
			this.openLightbox(host).catch((err) => {
				console.error("drawio-zoom-preview:", err);
				const detail = err && err.message ? err.message : String(err);
				new Notice(`Drawio 放大预览：打开失败（${detail}）`, 15000);
			});
		});
		actions.appendChild(zoomBtn);

		// "用默认应用打开"：仅桌面端、且该预览对应真实文件（代码块没有文件）
		const hasFile =
			host.classList.contains("drawio-embed") ||
			host.classList.contains("drawio-preview-file-view");
		if (Platform.isDesktopApp && hasFile) {
			const openBtn = document.createElement("button");
			openBtn.className = "dzp-btn dzp-open-btn";
			openBtn.type = "button";
			openBtn.setAttribute("aria-label", "用默认应用打开");
			openBtn.setAttribute("title", "用默认应用打开");
			openBtn.innerHTML = OPEN_ICON;
			openBtn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.openInDefaultApp(host);
			});
			actions.appendChild(openBtn);
		}

		host.appendChild(actions);
	}

	/* ---- 用默认应用打开 ---- */

	openInDefaultApp(host) {
		let file = null;
		if (host.classList.contains("drawio-embed")) {
			file = this.resolveEmbedFile(host);
		} else if (host.classList.contains("drawio-preview-file-view")) {
			file = this.resolveFileViewFile(host);
		}
		if (!file) {
			new Notice("Drawio 放大预览：未找到对应的图表文件");
			return;
		}
		openWithDefaultApp(this.app, file.path);
	}

	/* ---- 打开灯箱：收集当前 SVG、源 XML、页面信息 ---- */

	async openLightbox(host) {
		let phase = "init";
		try {
			return await this.doOpenLightbox(host, (p) => {
				phase = p;
			});
		} catch (err) {
			console.error(`drawio-zoom-preview: 打开失败（phase=${phase}）`, err);
			throw new Error(
				`phase=${phase}: ${err && err.message ? err.message : String(err)}`,
			);
		}
	}

	async doOpenLightbox(host, setPhase) {
		setPhase("find-svg");
		const liveSvg = host.querySelector(".drawio-preview svg");
		if (!liveSvg) {
			new Notice("Drawio 放大预览：预览尚未渲染完成");
			return;
		}
		const svgHtml = liveSvg.outerHTML;

		setPhase("resolve-source");
		let xml = null;
		let title = "Drawio diagram";
		let cacheKey = null;
		let cacheStamp = null;
		let openPath = null; // 能用默认应用打开的文件路径

		if (host.classList.contains("drawio-embed")) {
			setPhase("resolve-embed");
			const file = this.resolveEmbedFile(host);
			if (file) {
				setPhase("vault.read(embed)");
				xml = await this.app.vault.read(file);
				title = file.basename;
				cacheKey = file.path;
				cacheStamp = `${file.stat.mtime}:${isDarkRender(this.app) ? "dark" : "light"}`;
				openPath = file.path;
			}
		} else if (host.classList.contains("drawio-codeblock")) {
			setPhase("read-codeblock");
			xml = await this.readCodeBlockXml(host);
			const view = this.markdownViewForHost(host);
			title =
				view && view.file
					? `${view.file.basename} · drawio 代码块`
					: "drawio 代码块";
			if (xml) {
				cacheKey = `codeblock:${hashCode(normalizeXml(xml))}`;
				cacheStamp = isDarkRender(this.app) ? "dark" : "light";
			}
		} else if (host.classList.contains("drawio-preview-file-view")) {
			setPhase("resolve-fileview");
			const file = this.resolveFileViewFile(host);
			if (file) {
				setPhase("vault.read(fileview)");
				xml = await this.app.vault.read(file);
				title = file.basename;
				cacheKey = file.path;
				cacheStamp = `${file.stat.mtime}:${isDarkRender(this.app) ? "dark" : "light"}`;
				openPath = file.path;
			}
		}

		setPhase("parse-pages");
		let pages = xml ? parsePages(normalizeXml(xml)) : [];
		let initialPage = this.currentPageFromHost(host);
		if (initialPage >= pages.length) initialPage = 0;

		// 单页（或拿不到源 XML）→ 仅展示当前页克隆，不提供翻页
		if (pages.length <= 1) {
			xml = null;
			pages = [];
			initialPage = 0;
		}

		const cache =
			pages.length > 1 && cacheKey ? cacheFor(cacheKey, cacheStamp) : null;
		if (cache) cache.set(initialPage, svgHtml);

		setPhase("open-modal");
		if (lightboxOpen) return;
		new ZoomLightbox(this.app, {
			title,
			xml,
			pages,
			initialPage,
			svgHtml,
			cache,
			filePath: openPath,
		}).open();
	}

	/* ---- 各来源的解析辅助 ---- */

	// ![[x.drawio]] 嵌入：从 .internal-embed 的 src + 笔记路径解析出目标文件
	resolveEmbedFile(host) {
		const embedEl = host.classList.contains("internal-embed")
			? host
			: host.closest(".internal-embed");
		const src = embedEl ? embedEl.getAttribute("src") : null;
		if (!src) return null;
		const linkPath = src.split("#")[0];
		const pathEl = host.closest("[data-path]");
		let notePath = pathEl ? pathEl.getAttribute("data-path") : null;
		if (!notePath) {
			const active = this.app.workspace.getActiveFile();
			notePath = active ? active.path : "/";
		}
		return this.app.metadataCache.getFirstLinkpathDest(
			linkPath,
			notePath || "/",
		);
	}

	// 找到 host 实际所在的 MarkdownView。不能用"当前激活视图"：
	// 悬停预览、Hover Editor、非焦点分屏里激活的可能是别的笔记
	markdownViewForHost(host) {
		let found = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (found) return;
			const view = leaf.view;
			if (
				view instanceof MarkdownView &&
				view.containerEl &&
				view.containerEl.contains(host)
			) {
				found = view;
			}
		});
		return found || this.app.workspace.getActiveViewOfType(MarkdownView);
	}

	// ```drawio 代码块：通过 MarkdownView.getSectionInfo 回读源码
	async readCodeBlockXml(host) {
		try {
			const view = this.markdownViewForHost(host);
			if (!view || !view.file) return null;
			const sec =
				typeof view.getSectionInfo === "function"
					? view.getSectionInfo(host)
					: null;
			if (!sec) return null;
			const text = view.editor
				? view.editor.getValue()
				: await this.app.vault.read(view.file);
			const lines = text.split("\n");
			const seg = lines.slice(sec.lineStart, sec.lineEnd + 1);
			if (
				seg.length >= 2 &&
				/^\s*(```|~~~)/.test(seg[0]) &&
				/(```|~~~)\s*$/.test(seg[seg.length - 1])
			) {
				return seg.slice(1, -1).join("\n");
			}
			return seg.join("\n");
		} catch {
			return null;
		}
	}

	// .drawio 只读文件视图：找到所属 TextFileView 的文件
	resolveFileViewFile(host) {
		try {
			for (const leaf of this.app.workspace.getLeavesOfType(FILE_VIEW_TYPE)) {
				const view = leaf.view;
				if (
					view &&
					view.contentEl &&
					(view.contentEl === host || view.contentEl.contains(host))
				) {
					if (view.file) return view.file;
				}
			}
		} catch {
			/* 落入兜底 */
		}
		const active = this.app.workspace.getActiveFile();
		return active && active.extension === "drawio" ? active : null;
	}

	// 读取宿主预览当前显示的页码（".drawio-page-control" 里的 "2 / 5"）
	currentPageFromHost(host) {
		const label = host.querySelector(".drawio-page-control span");
		if (!label) return 0;
		const m = /(\d+)\s*\/\s*(\d+)/.exec(label.textContent || "");
		return m ? Math.max(parseInt(m[1], 10) - 1, 0) : 0;
	}
};
