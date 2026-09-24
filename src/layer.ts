import { MarkdownView, Menu } from "obsidian";
import {
	Cover,
	HANDLE_CURSORS,
	HANDLE_ROLES,
	HANDLE_SIZE,
	HandleRole,
	MIN_SIZE,
	Mode,
	OcclusionSettings,
	PenCover,
	RectangleCover,
	TextCover,
	applyRoleResize,
	handleAnchor,
	isPenCover,
	isRectangleCover,
	isTextCover,
	randomId,
} from "./types";
import {
	TEXT_CONTEXT_LENGTH,
	collapseWhitespace,
	pickTextCandidate,
} from "./text-anchor";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface LayerContext {
	getMode(): Mode;
	getColor(): string;
	getPenWidth(): number;
	getSettings(): OcclusionSettings;
	getCovers(path: string): Cover[];
	setCovers(path: string, covers: Cover[], remember?: boolean): void;
	rememberState(path: string, covers: Cover[]): void;
	onChanged(): void;
}

interface PixelRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

interface PenElements {
	wrap: HTMLDivElement;
	svg: SVGSVGElement;
	path: SVGPathElement;
}

type Drag =
	| { kind: "new"; from: { x: number; y: number }; to: { x: number; y: number } }
	| { kind: "pen"; points: Array<{ x: number; y: number }> }
	| { kind: "move"; id: string; from: { x: number; y: number }; orig: PixelRect }
	| {
			kind: "resize";
			id: string;
			role: HandleRole;
			from: { x: number; y: number };
			orig: PixelRect;
	  };

/**
 * Draws a note's covers into its view and handles the pointer work.
 *
 * The cover elements live inside the view's scrolling element so they travel
 * with the text, and their positions are measured against the content element
 * so a pane resize moves them with the words underneath.
 */
export class OcclusionLayer {
	readonly view: MarkdownView;
	private ctx: LayerContext;

	private host: HTMLElement | null = null;
	private anchor: HTMLElement | null = null;
	private layerEl: HTMLElement | null = null;
	private captureEl: HTMLElement | null = null;
	private previewEl: HTMLElement | null = null;
	private penPreviewEl: SVGSVGElement | null = null;
	private penPreviewPath: SVGPathElement | null = null;

	private elements = new Map<string, HTMLElement[]>();
	private penElements = new Map<string, PenElements>();
	private handleEls: HTMLElement[] = [];
	private selectedId: string | null = null;
	private drag: Drag | null = null;
	private dragOrigin: Cover[] | null = null;
	private observer: ResizeObserver | null = null;
	private mutationObserver: MutationObserver | null = null;
	private frame = 0;

	constructor(view: MarkdownView, ctx: LayerContext) {
		this.view = view;
		this.ctx = ctx;
		this.observer = new ResizeObserver(() => this.scheduleRender());
		this.mutationObserver = new MutationObserver(() => this.scheduleRender());
	}

	get path(): string | null {
		return this.view.file?.path ?? null;
	}

	/** True when the view still holds the DOM this layer was built against. */
	isStale(): boolean {
		const targets = this.resolveTargets();
		return !targets || targets.host !== this.host || targets.anchor !== this.anchor;
	}

	private resolveTargets(): { host: HTMLElement; anchor: HTMLElement } | null {
		const root = this.view.contentEl;
		const reading = this.view.getMode() === "preview";
		const host = root.querySelector<HTMLElement>(
			reading ? ".markdown-preview-view" : ".cm-scroller"
		);
		const anchor = root.querySelector<HTMLElement>(
			reading ? ".markdown-preview-sizer" : ".cm-content"
		);
		if (!host || !anchor) return null;
		return { host, anchor };
	}

	attach(): boolean {
		const targets = this.resolveTargets();
		if (!targets) return false;
		this.detachDom();
		this.host = targets.host;
		this.anchor = targets.anchor;

		const layer = this.host.createDiv({ cls: "occ-layer" });
		layer.setAttribute("contenteditable", "false");
		layer.setAttribute("aria-hidden", "true");
		this.layerEl = layer;

		const capture = this.view.contentEl.createDiv({ cls: "occ-capture" });
		capture.setCssStyles({ display: "none" });
		this.captureEl = capture;

		const preview = layer.createDiv({ cls: "occ-preview" });
		preview.setCssStyles({ display: "none" });
		this.previewEl = preview;
		const penPreview = this.anchor.ownerDocument.createElementNS(SVG_NS, "svg");
		penPreview.classList.add("occ-pen-preview", "occ-hidden");
		const penPreviewPath = this.anchor.ownerDocument.createElementNS(SVG_NS, "path");
		penPreview.appendChild(penPreviewPath);
		layer.appendChild(penPreview);
		this.penPreviewEl = penPreview;
		this.penPreviewPath = penPreviewPath;

		capture.addEventListener("pointerdown", this.onPointerDown);
		capture.addEventListener("pointermove", this.onPointerMove);
		capture.addEventListener("pointerup", this.onPointerUp);
		capture.addEventListener("pointercancel", this.onPointerCancel);
		capture.addEventListener("contextmenu", this.onContextMenu);
		capture.addEventListener("dblclick", this.onDoubleClick);
		this.anchor.addEventListener("pointerup", this.onTextSelection);

		this.observer?.observe(this.anchor);
		this.observer?.observe(this.host);
		this.mutationObserver?.observe(this.anchor, {
			childList: true,
			characterData: true,
			subtree: true,
		});
		this.render();
		return true;
	}

	private detachDom(): void {
		this.observer?.disconnect();
		this.mutationObserver?.disconnect();
		this.anchor?.removeEventListener("pointerup", this.onTextSelection);
		this.anchor?.classList.remove("occ-text-mode");
		this.captureEl?.remove();
		this.layerEl?.remove();
		this.elements.clear();
		this.penElements.clear();
		this.handleEls = [];
		this.layerEl = null;
		this.captureEl = null;
		this.previewEl = null;
		this.penPreviewEl = null;
		this.penPreviewPath = null;
	}

	destroy(): void {
		this.detachDom();
		this.observer = null;
		this.mutationObserver = null;
		this.host = null;
		this.anchor = null;
	}

	scheduleRender(): void {
		if (this.frame) return;
		const win = this.view.contentEl.win ?? window;
		this.frame = win.requestAnimationFrame(() => {
			this.frame = 0;
			this.render();
		});
	}

	private anchorWidth(): number {
		return Math.max(1, this.anchor?.clientWidth ?? 1);
	}

	/** Offset of the content element inside the scrolling coordinate space. */
	private contentOffset(): { left: number; top: number } {
		if (!this.host || !this.anchor) return { left: 0, top: 0 };
		const hostRect = this.host.getBoundingClientRect();
		const anchorRect = this.anchor.getBoundingClientRect();
		return {
			left: anchorRect.left - hostRect.left + this.host.scrollLeft,
			top: anchorRect.top - hostRect.top + this.host.scrollTop,
		};
	}

	private toPixels(cover: RectangleCover): PixelRect {
		const width = this.anchorWidth();
		return { x: cover.x * width, y: cover.y, w: cover.w * width, h: cover.h };
	}

	private fromPixels(rect: PixelRect): Pick<RectangleCover, "x" | "y" | "w" | "h"> {
		const width = this.anchorWidth();
		return { x: rect.x / width, y: rect.y, w: rect.w / width, h: rect.h };
	}

	/** Pointer position in content coordinates (pixels from the content corner). */
	private pointAt(event: PointerEvent | MouseEvent): { x: number; y: number } {
		if (!this.anchor) return { x: 0, y: 0 };
		const rect = this.anchor.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	}

	private coverAt(
		point: { x: number; y: number },
		includeText = true,
		includePen = true
	): Cover | null {
		const covers = this.covers();
		for (let i = covers.length - 1; i >= 0; i -= 1) {
			const cover = covers[i];
			if (!includeText && isTextCover(cover)) continue;
			if (isPenCover(cover)) {
				if (includePen && this.penContains(cover, point)) return cover;
				continue;
			}
			for (const r of this.rectsFor(cover)) {
				if (
					point.x >= r.x &&
					point.x <= r.x + r.w &&
					point.y >= r.y &&
					point.y <= r.y + r.h
				) {
					return cover;
				}
			}
		}
		return null;
	}

	private handleAt(point: { x: number; y: number }): HandleRole | null {
		const cover = this.covers().find((c) => c.id === this.selectedId);
		if (!cover || !isRectangleCover(cover)) return null;
		const r = this.toPixels(cover);
		for (const role of HANDLE_ROLES) {
			const [hx, hy] = handleAnchor(role, r.x, r.y, r.w, r.h);
			if (
				point.x >= hx &&
				point.x <= hx + HANDLE_SIZE &&
				point.y >= hy &&
				point.y <= hy + HANDLE_SIZE
			) {
				return role;
			}
		}
		return null;
	}

	private covers(): Cover[] {
		const path = this.path;
		return path ? this.ctx.getCovers(path) : [];
	}

	private rectsFor(cover: Cover): PixelRect[] {
		if (isRectangleCover(cover)) return [this.toPixels(cover)];
		if (isPenCover(cover)) return [penBounds(this.penPoints(cover), cover.width)];
		const range = this.findTextRange(cover);
		if (!range || !this.anchor) return [];
		const anchorRect = this.anchor.getBoundingClientRect();
		return Array.from(range.getClientRects())
			.filter((rect) => rect.width > 0 && rect.height > 0)
			.map((rect) => ({
				x: rect.left - anchorRect.left,
				y: rect.top - anchorRect.top,
				w: rect.width,
				h: rect.height,
			}));
	}

	private penPoints(cover: PenCover): Array<{ x: number; y: number }> {
		const width = this.anchorWidth();
		return cover.points.map((point) => ({ x: point.x * width, y: point.y }));
	}

	private penContains(cover: PenCover, point: { x: number; y: number }): boolean {
		const points = this.penPoints(cover);
		const radius = Math.max(4, cover.width / 2);
		if (points.length === 1) return distance(points[0], point) <= radius;
		for (let i = 1; i < points.length; i += 1) {
			if (distanceToSegment(point, points[i - 1], points[i]) <= radius) return true;
		}
		return false;
	}

	private findTextRange(cover: TextCover): Range | null {
		if (!this.anchor) return null;
		const { nodes, full } = this.anchorText();
		// Demand a confident, unique match: with CodeMirror unmounting
		// off-screen lines, the true occurrence can be absent while a
		// duplicate is visible. Guessing then paints the wrong words.
		const hit = pickTextCandidate(full, cover.exact, cover.prefix, cover.suffix);
		if (!hit) return null;
		// Never paint a range broader than the quote this cover represents.
		if (collapseWhitespace(full.slice(hit.start, hit.end)) !== collapseWhitespace(cover.exact)) {
			return null;
		}
		const start = textPosition(nodes, hit.start, "start");
		const end = textPosition(nodes, hit.end, "end");
		if (!start || !end) return null;
		const range = this.anchor.ownerDocument.createRange();
		range.setStart(start.node, start.offset);
		range.setEnd(end.node, end.offset);
		return range;
	}

	/** Text nodes and their joined text, the same model capture uses. */
	private anchorText(): { nodes: Text[]; full: string } {
		const nodes: Text[] = [];
		if (!this.anchor) return { nodes, full: "" };
		const walker = this.anchor.ownerDocument.createTreeWalker(this.anchor, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			nodes.push(node as Text);
			node = walker.nextNode();
		}
		return { nodes, full: nodes.map((text) => text.data).join("") };
	}

	private selectionOffsets(nodes: Text[], range: Range): { start: number; end: number } | null {
		const start = this.globalOffsetFor(nodes, range.startContainer, range.startOffset);
		const end = this.globalOffsetFor(nodes, range.endContainer, range.endOffset);
		if (start == null || end == null || end < start) return null;
		return { start, end };
	}

	/**
	 * Global text offset of a DOM boundary point. Element boundaries fall
	 * between text nodes, so every node starting before the point lies
	 * fully inside it; a null means the point is outside this model.
	 */
	private globalOffsetFor(nodes: Text[], container: Node, offset: number): number | null {
		if (container.nodeType === Node.TEXT_NODE) {
			let acc = 0;
			for (const node of nodes) {
				if (node === container) {
					if (offset < 0 || offset > node.data.length) return null;
					return acc + offset;
				}
				acc += node.data.length;
			}
			return null;
		}
		if (container.nodeType !== Node.ELEMENT_NODE) return null;
		const doc = this.anchor?.ownerDocument;
		if (!doc) return null;
		let point: Range;
		try {
			point = doc.createRange();
			point.setStart(container, offset);
			point.collapse(true);
		} catch {
			return null;
		}
		let acc = 0;
		for (const node of nodes) {
			let cmp: number;
			try {
				cmp = point.comparePoint(node, 0);
			} catch {
				return null;
			}
			if (cmp !== -1) break;
			acc += node.data.length;
		}
		return acc;
	}

	private commit(covers: Cover[], remember = true): void {
		const path = this.path;
		if (!path) return;
		this.ctx.setCovers(path, covers, remember);
		this.render();
		this.ctx.onChanged();
	}

	private replace(
		id: string,
		patch: Partial<Pick<RectangleCover, "x" | "y" | "w" | "h" | "color" | "covered">>,
		remember = true
	): void {
		this.commit(
			this.covers().map((c) => (c.id === id ? { ...c, ...patch } : c)),
			remember
		);
	}

	toggle(id: string): void {
		const cover = this.covers().find((c) => c.id === id);
		if (cover) this.replace(id, { covered: !cover.covered });
	}

	setAllCovered(covered: boolean): void {
		this.commit(this.covers().map((c) => ({ ...c, covered })));
	}

	clearAll(): void {
		this.commit([]);
		this.selectedId = null;
	}

	addTestCover(): void {
		const width = this.anchorWidth();
		const top = (this.host?.scrollTop ?? 0) - this.contentOffset().top + 40;
		this.commit([
			...this.covers(),
			{
				id: randomId(),
				x: 0.2,
				y: Math.max(0, top),
				w: Math.min(0.6, 240 / width),
				h: 60,
				color: this.ctx.getColor(),
				covered: true,
			},
		]);
	}

	render(): void {
		if (!this.layerEl || !this.anchor || !this.host) return;
		const mode = this.ctx.getMode();
		const settings = this.ctx.getSettings();
		const offset = this.contentOffset();
		const covers = this.covers();

		if (this.captureEl) {
			const active = mode === "draw" || mode === "pen" || mode === "delete";
			this.captureEl.setCssStyles({ display: active ? "block" : "none" });
			this.captureEl.classList.toggle("occ-cursor-delete", mode === "delete");
			this.captureEl.classList.toggle("occ-cursor-pen", mode === "pen");
		}
		this.anchor.classList.toggle("occ-text-mode", mode === "text");
		this.layerEl.classList.toggle("occ-mode-draw", mode === "draw");
		this.layerEl.classList.toggle("occ-mode-pen", mode === "pen");
		this.layerEl.classList.toggle("occ-mode-text", mode === "text");
		this.layerEl.classList.toggle("occ-mode-delete", mode === "delete");
		this.layerEl.classList.toggle("occ-mode-reveal", mode === "reveal");
		this.layerEl.classList.toggle("occ-mode-pass", mode === "pass");

		const seen = new Set<string>();
		for (const cover of covers) {
			seen.add(cover.id);
			if (isPenCover(cover)) {
				this.coverElements(cover.id, 0);
				this.renderPen(cover, offset, mode, settings);
				continue;
			}
			this.removePen(cover.id);
			const rects = this.rectsFor(cover);
			const els = this.coverElements(cover.id, rects.length);
			els.forEach((el, index) => {
				const r = rects[index];
				el.setCssStyles({
					left: `${offset.left + r.x}px`,
					top: `${offset.top + r.y}px`,
					width: `${r.w}px`,
					height: `${r.h}px`,
					background: cover.covered ? cover.color : "transparent",
					opacity: cover.covered ? String(settings.coverOpacity) : "1",
					pointerEvents: mode === "reveal" ? "auto" : "none",
					borderColor: cover.color,
				});
				el.classList.toggle("occ-text-cover", isTextCover(cover));
				el.classList.toggle("occ-revealed", !cover.covered);
				el.classList.toggle("occ-marked", !cover.covered && settings.markRevealed);
				el.classList.toggle("occ-selected", mode === "draw" && cover.id === this.selectedId);
				this.layerEl?.appendChild(el);
			});
		}

		for (const [id, els] of this.elements) {
			if (!seen.has(id)) {
				els.forEach((el) => el.remove());
				this.elements.delete(id);
			}
		}
		for (const [id] of this.penElements) {
			if (!seen.has(id)) this.removePen(id);
		}
		if (this.selectedId && !seen.has(this.selectedId)) this.selectedId = null;

		this.renderHandles(offset);
	}

	private renderPen(
		cover: PenCover,
		offset: { left: number; top: number },
		mode: Mode,
		settings: OcclusionSettings
	): void {
		if (!this.layerEl || !this.anchor) return;
		let elements = this.penElements.get(cover.id);
		if (!elements) {
			// Dynamic placement lives on an HTML wrapper (setCssStyles) so
			// the SVG itself stays purely attribute-driven.
			const wrap = this.layerEl.createDiv({ cls: "occ-pen-cover" });
			const svg = this.anchor.ownerDocument.createElementNS(SVG_NS, "svg");
			const path = this.anchor.ownerDocument.createElementNS(SVG_NS, "path");
			path.setAttribute("fill", "none");
			path.setAttribute("stroke-linecap", "round");
			path.setAttribute("stroke-linejoin", "round");
			path.addEventListener("click", (event) => {
				if (this.ctx.getMode() !== "reveal") return;
				event.preventDefault();
				event.stopPropagation();
				this.toggle(cover.id);
			});
			path.addEventListener("contextmenu", (event) => {
				if (this.ctx.getMode() === "pass") return;
				event.preventDefault();
				event.stopPropagation();
				this.openMenu(event, cover.id);
			});
			svg.appendChild(path);
			wrap.appendChild(svg);
			this.layerEl.appendChild(wrap);
			elements = { wrap, svg, path };
			this.penElements.set(cover.id, elements);
		}

		const points = this.penPoints(cover);
		const bounds = penBounds(points, cover.width);
		const local = points.map((point) => ({ x: point.x - bounds.x, y: point.y - bounds.y }));
		const { wrap, svg, path } = elements;
		wrap.setCssStyles({
			left: `${offset.left + bounds.x}px`,
			top: `${offset.top + bounds.y}px`,
		});
		svg.setAttribute("width", String(Math.max(1, bounds.w)));
		svg.setAttribute("height", String(Math.max(1, bounds.h)));
		svg.setAttribute("viewBox", `0 0 ${Math.max(1, bounds.w)} ${Math.max(1, bounds.h)}`);
		path.setAttribute("d", penPath(local));
		path.setAttribute("stroke-width", String(cover.width));
		path.setAttribute("stroke", cover.covered || settings.markRevealed ? cover.color : "transparent");
		path.setAttribute(
			"opacity",
			cover.covered ? String(settings.coverOpacity) : settings.markRevealed ? "0.45" : "1"
		);
		path.setAttribute("stroke-dasharray", !cover.covered && settings.markRevealed ? "4 4" : "none");
		path.setAttribute("pointer-events", mode === "reveal" ? "stroke" : "none");
		this.layerEl.appendChild(wrap);
	}

	private removePen(id: string): void {
		this.penElements.get(id)?.wrap.remove();
		this.penElements.delete(id);
	}

	private coverElements(id: string, count: number): HTMLElement[] {
		if (!this.layerEl) return [];
		const els = this.elements.get(id) ?? [];
		while (els.length < count) {
			const el = this.layerEl.createDiv({ cls: "occ-cover" });
			el.addEventListener("click", (event) => {
				if (this.ctx.getMode() !== "reveal") return;
				event.preventDefault();
				event.stopPropagation();
				this.toggle(id);
			});
			el.addEventListener("contextmenu", (event) => {
				if (this.ctx.getMode() === "pass") return;
				event.preventDefault();
				event.stopPropagation();
				this.openMenu(event, id);
			});
			els.push(el);
		}
		while (els.length > count) els.pop()?.remove();
		this.elements.set(id, els);
		return els;
	}

	private renderHandles(offset: { left: number; top: number }): void {
		const wanted =
			this.ctx.getMode() === "draw" && this.selectedId
				? this.covers().find((c) => c.id === this.selectedId) ?? null
				: null;

		if (!wanted || !isRectangleCover(wanted)) {
			this.handleEls.forEach((el) => el.remove());
			this.handleEls = [];
			return;
		}
		if (this.handleEls.length === 0 && this.layerEl) {
			for (const role of HANDLE_ROLES) {
				const el = this.layerEl.createDiv({ cls: "occ-handle" });
				el.dataset.role = role;
				el.setCssStyles({ cursor: HANDLE_CURSORS[role] });
				this.handleEls.push(el);
			}
		}
		const r = this.toPixels(wanted);
		this.handleEls.forEach((el) => {
			const role = el.dataset.role as HandleRole;
			const [hx, hy] = handleAnchor(role, r.x, r.y, r.w, r.h);
			el.setCssStyles({
				left: `${offset.left + hx}px`,
				top: `${offset.top + hy}px`,
			});
		});
	}

	private showPreview(rect: PixelRect | null): void {
		if (!this.previewEl) return;
		if (!rect) {
			this.previewEl.setCssStyles({ display: "none" });
			return;
		}
		const offset = this.contentOffset();
		this.previewEl.setCssStyles({
			display: "block",
			left: `${offset.left + rect.x}px`,
			top: `${offset.top + rect.y}px`,
			width: `${rect.w}px`,
			height: `${rect.h}px`,
			background: this.ctx.getColor(),
		});
	}

	private showPenPreview(points: Array<{ x: number; y: number }> | null): void {
		if (!this.penPreviewEl || !this.penPreviewPath) return;
		if (!points || points.length === 0) {
			this.penPreviewEl.classList.add("occ-hidden");
			return;
		}
		const offset = this.contentOffset();
		const shifted = points.map((point) => ({ x: point.x + offset.left, y: point.y + offset.top }));
		this.penPreviewEl.classList.remove("occ-hidden");
		this.penPreviewPath.setAttribute("d", penPath(shifted));
		this.penPreviewPath.setAttribute("stroke", this.ctx.getColor());
		this.penPreviewPath.setAttribute("stroke-width", String(this.ctx.getPenWidth()));
	}

	private onTextSelection = (event: PointerEvent): void => {
		if (event.button !== 0 || this.ctx.getMode() !== "text" || !this.anchor) return;
		const selection = this.anchor.ownerDocument.getSelection();
		if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
		const range = selection.getRangeAt(0);
		if (!this.anchor.contains(range.startContainer) || !this.anchor.contains(range.endContainer)) return;
		// Capture from the same joined-text model the lookup searches, so
		// the stored quote always matches its own context exactly.
		const { nodes, full } = this.anchorText();
		const offsets = this.selectionOffsets(nodes, range);
		if (!offsets) return;
		const exact = full.slice(offsets.start, offsets.end);
		if (!exact.trim()) return;

		const cover: TextCover = {
			id: randomId(),
			kind: "text",
			exact,
			prefix: full.slice(Math.max(0, offsets.start - TEXT_CONTEXT_LENGTH), offsets.start),
			suffix: full.slice(offsets.end, offsets.end + TEXT_CONTEXT_LENGTH),
			color: this.ctx.getColor(),
			covered: true,
		};
		this.commit([...this.covers(), cover]);
		selection.removeAllRanges();
	};

	private onPointerDown = (event: PointerEvent): void => {
		const mode = this.ctx.getMode();
		if (event.button !== 0 || (mode !== "draw" && mode !== "pen")) return;
		const point = this.pointAt(event);
		this.captureEl?.setPointerCapture(event.pointerId);
		if (mode === "pen") {
			this.selectedId = null;
			this.dragOrigin = null;
			this.drag = { kind: "pen", points: [point] };
			this.showPenPreview([point]);
			return;
		}

		this.dragOrigin = this.covers().map((c) => ({ ...c }));
		const role = this.handleAt(point);
		if (role && this.selectedId) {
			const cover = this.covers().find((c) => c.id === this.selectedId);
			if (cover && isRectangleCover(cover)) {
				this.drag = { kind: "resize", id: cover.id, role, from: point, orig: this.toPixels(cover) };
				return;
			}
		}
		const hit = this.coverAt(point, false, false);
		if (hit && isRectangleCover(hit)) {
			this.selectedId = hit.id;
			this.drag = { kind: "move", id: hit.id, from: point, orig: this.toPixels(hit) };
			this.render();
			return;
		}
		this.selectedId = null;
		this.drag = { kind: "new", from: point, to: point };
		this.render();
	};

	private onPointerMove = (event: PointerEvent): void => {
		if (!this.drag) {
			if (this.ctx.getMode() === "draw" && this.captureEl) {
				const point = this.pointAt(event);
				const role = this.handleAt(point);
				this.captureEl.setCssStyles({
					cursor: role
						? HANDLE_CURSORS[role]
						: this.coverAt(point, false, false)
						? "move"
						: "crosshair",
				});
			}
			return;
		}
		const point = this.pointAt(event);
		if (this.drag.kind === "pen") {
			const last = this.drag.points[this.drag.points.length - 1];
			if (distance(last, point) >= 1.5) this.drag.points.push(point);
			this.showPenPreview(this.drag.points);
			return;
		}
		if (this.drag.kind === "new") {
			this.drag.to = point;
			this.showPreview(normalise(this.drag.from, point));
			return;
		}
		const dx = point.x - this.drag.from.x;
		const dy = point.y - this.drag.from.y;
		if (this.drag.kind === "move") {
			const o = this.drag.orig;
			this.replace(this.drag.id, this.fromPixels({ ...o, x: o.x + dx, y: o.y + dy }), false);
		} else {
			const o = this.drag.orig;
			const [nx, ny, nw, nh] = applyRoleResize(this.drag.role, o.x, o.y, o.w, o.h, dx, dy);
			this.replace(this.drag.id, this.fromPixels({ x: nx, y: ny, w: nw, h: nh }), false);
		}
	};

	private onPointerUp = (event: PointerEvent): void => {
		const drag = this.drag;
		this.drag = null;
		this.showPreview(null);
		this.showPenPreview(null);
		if (!drag) return;
		const point = this.pointAt(event);
		if (drag.kind === "pen") {
			const last = drag.points[drag.points.length - 1];
			if (distance(last, point) >= 1.5) drag.points.push(point);
			const width = this.anchorWidth();
			const cover: PenCover = {
				id: randomId(),
				kind: "pen",
				points: drag.points.map((sample) => ({ x: sample.x / width, y: sample.y })),
				width: this.ctx.getPenWidth(),
				color: this.ctx.getColor(),
				covered: true,
			};
			this.commit([...this.covers(), cover]);
			return;
		}

		if (drag.kind === "new") {
			const rect = normalise(drag.from, point);
			if (rect.w < MIN_SIZE || rect.h < MIN_SIZE) {
				this.render();
				return;
			}
			const cover: Cover = {
				id: randomId(),
				...this.fromPixels(rect),
				color: this.ctx.getColor(),
				covered: true,
			};
			this.dragOrigin = null;
			this.commit([...this.covers(), cover]);
			this.selectedId = cover.id;
			this.render();
			return;
		}
		// the move or resize wrote intermediate states with remember=false, so
		// push the snapshot taken at pointerdown as the single undo step
		const path = this.path;
		if (path && this.dragOrigin && this.movedFrom(drag)) {
			this.ctx.rememberState(path, this.dragOrigin);
		}
		this.dragOrigin = null;
		this.render();
	};

	private onPointerCancel = (): void => this.cancelDrag();

	/** True when a move or resize actually changed the cover. */
	private movedFrom(drag: Drag): boolean {
		if (drag.kind === "new" || drag.kind === "pen") return false;
		const current = this.covers().find((c) => c.id === drag.id);
		if (!current || !isRectangleCover(current)) return false;
		const now = this.toPixels(current);
		const o = drag.orig;
		return (
			Math.abs(now.x - o.x) > 0.5 ||
			Math.abs(now.y - o.y) > 0.5 ||
			Math.abs(now.w - o.w) > 0.5 ||
			Math.abs(now.h - o.h) > 0.5
		);
	}

	private onDoubleClick = (event: MouseEvent): void => {
		if (this.ctx.getMode() !== "draw") return;
		const hit = this.coverAt(this.pointAt(event), false, false);
		if (hit) {
			event.preventDefault();
			this.toggle(hit.id);
		}
	};

	private onContextMenu = (event: MouseEvent): void => {
		const mode = this.ctx.getMode();
		if (mode === "delete") {
			const hit = this.coverAt(this.pointAt(event));
			event.preventDefault();
			if (hit) this.deleteCover(hit.id);
			return;
		}
		if (mode !== "draw" && mode !== "pen") return;
		const hit = this.coverAt(this.pointAt(event), false, mode === "pen");
		event.preventDefault();
		if (hit) this.openMenu(event, hit.id);
	};

	private deleteCover(id: string): void {
		this.commit(this.covers().filter((c) => c.id !== id));
		if (this.selectedId === id) this.selectedId = null;
	}

	private openMenu(event: MouseEvent, id: string): void {
		const cover = this.covers().find((c) => c.id === id);
		if (!cover) return;
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(cover.covered ? "Reveal" : "Cover again")
				.setIcon(cover.covered ? "eye" : "eye-off")
				.onClick(() => this.toggle(id))
		);
		menu.addSeparator();
		for (const swatch of this.ctx.getSettings().swatches) {
			menu.addItem((item) =>
				item
					.setTitle(swatch)
					.setIcon(cover.color.toLowerCase() === swatch.toLowerCase() ? "check" : "palette")
					.onClick(() => this.replace(id, { color: swatch }))
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Bring to front")
				.setIcon("arrow-up")
				.onClick(() => {
					const rest = this.covers().filter((c) => c.id !== id);
					this.commit([...rest, cover]);
				})
		);
		menu.addItem((item) =>
			item
				.setTitle("Delete")
				.setIcon("trash-2")
				.onClick(() => this.deleteCover(id))
		);
		menu.showAtMouseEvent(event);
	}

	cancelDrag(): void {
		if (!this.drag) return;
		if (this.drag.kind === "move" || this.drag.kind === "resize") {
			this.replace(this.drag.id, this.fromPixels(this.drag.orig), false);
		}
		this.drag = null;
		this.dragOrigin = null;
		this.showPreview(null);
		this.showPenPreview(null);
		this.render();
	}
}

function normalise(a: { x: number; y: number }, b: { x: number; y: number }): PixelRect {
	return {
		x: Math.min(a.x, b.x),
		y: Math.min(a.y, b.y),
		w: Math.abs(b.x - a.x),
		h: Math.abs(b.y - a.y),
	};
}

function penBounds(points: Array<{ x: number; y: number }>, width: number): PixelRect {
	const pad = width / 2 + 1;
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const left = Math.min(...xs) - pad;
	const top = Math.min(...ys) - pad;
	return {
		x: left,
		y: top,
		w: Math.max(1, Math.max(...xs) + pad - left),
		h: Math.max(1, Math.max(...ys) + pad - top),
	};
}

function penPath(points: Array<{ x: number; y: number }>): string {
	if (points.length === 0) return "";
	if (points.length === 1) return `M ${points[0].x} ${points[0].y} l 0.01 0`;
	return points
		.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
		.join(" ");
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceToSegment(
	point: { x: number; y: number },
	start: { x: number; y: number },
	end: { x: number; y: number }
): number {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	if (dx === 0 && dy === 0) return distance(point, start);
	const t = Math.max(
		0,
		Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy))
	);
	return distance(point, { x: start.x + t * dx, y: start.y + t * dy });
}

function textPosition(
	nodes: Text[],
	index: number,
	affinity: "start" | "end"
): { node: Text; offset: number } | null {
	let remaining = index;
	for (let i = 0; i < nodes.length; i += 1) {
		const node = nodes[i];
		if (remaining < node.data.length) return { node, offset: remaining };
		if (remaining === node.data.length) {
			if (affinity === "start" && i + 1 < nodes.length) {
				const next = nodes.slice(i + 1).find((candidate) => candidate.data.length > 0);
				if (next) return { node: next, offset: 0 };
			}
			return { node, offset: remaining };
		}
		remaining -= node.data.length;
	}
	return null;
}
