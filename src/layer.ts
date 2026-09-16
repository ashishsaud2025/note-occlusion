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
	applyRoleResize,
	handleAnchor,
	randomId,
} from "./types";

export interface LayerContext {
	getMode(): Mode;
	getColor(): string;
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

type Drag =
	| { kind: "new"; from: { x: number; y: number }; to: { x: number; y: number } }
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

	private elements = new Map<string, HTMLElement>();
	private handleEls: HTMLElement[] = [];
	private selectedId: string | null = null;
	private drag: Drag | null = null;
	private dragOrigin: Cover[] | null = null;
	private observer: ResizeObserver | null = null;
	private frame = 0;

	constructor(view: MarkdownView, ctx: LayerContext) {
		this.view = view;
		this.ctx = ctx;
		this.observer = new ResizeObserver(() => this.scheduleRender());
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

		const layer = document.createElement("div");
		layer.className = "occ-layer";
		layer.setAttribute("contenteditable", "false");
		layer.setAttribute("aria-hidden", "true");
		this.host.appendChild(layer);
		this.layerEl = layer;

		const capture = document.createElement("div");
		capture.className = "occ-capture";
		capture.style.display = "none";
		this.view.contentEl.appendChild(capture);
		this.captureEl = capture;

		const preview = document.createElement("div");
		preview.className = "occ-preview";
		preview.style.display = "none";
		layer.appendChild(preview);
		this.previewEl = preview;

		capture.addEventListener("pointerdown", this.onPointerDown);
		capture.addEventListener("pointermove", this.onPointerMove);
		capture.addEventListener("pointerup", this.onPointerUp);
		capture.addEventListener("pointercancel", this.onPointerUp);
		capture.addEventListener("contextmenu", this.onContextMenu);
		capture.addEventListener("dblclick", this.onDoubleClick);

		this.observer?.observe(this.anchor);
		this.observer?.observe(this.host);
		this.render();
		return true;
	}

	private detachDom(): void {
		this.observer?.disconnect();
		this.captureEl?.remove();
		this.layerEl?.remove();
		this.elements.clear();
		this.handleEls = [];
		this.layerEl = null;
		this.captureEl = null;
		this.previewEl = null;
	}

	destroy(): void {
		this.detachDom();
		this.observer = null;
		this.host = null;
		this.anchor = null;
	}

	scheduleRender(): void {
		if (this.frame) return;
		this.frame = requestAnimationFrame(() => {
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

	private toPixels(cover: Cover): PixelRect {
		const width = this.anchorWidth();
		return { x: cover.x * width, y: cover.y, w: cover.w * width, h: cover.h };
	}

	private fromPixels(rect: PixelRect): Pick<Cover, "x" | "y" | "w" | "h"> {
		const width = this.anchorWidth();
		return { x: rect.x / width, y: rect.y, w: rect.w / width, h: rect.h };
	}

	/** Pointer position in content coordinates (pixels from the content corner). */
	private pointAt(event: PointerEvent | MouseEvent): { x: number; y: number } {
		if (!this.anchor) return { x: 0, y: 0 };
		const rect = this.anchor.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	}

	private coverAt(point: { x: number; y: number }): Cover | null {
		const covers = this.covers();
		for (let i = covers.length - 1; i >= 0; i -= 1) {
			const r = this.toPixels(covers[i]);
			if (
				point.x >= r.x &&
				point.x <= r.x + r.w &&
				point.y >= r.y &&
				point.y <= r.y + r.h
			) {
				return covers[i];
			}
		}
		return null;
	}

	private handleAt(point: { x: number; y: number }): HandleRole | null {
		const cover = this.covers().find((c) => c.id === this.selectedId);
		if (!cover) return null;
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

	private commit(covers: Cover[], remember = true): void {
		const path = this.path;
		if (!path) return;
		this.ctx.setCovers(path, covers, remember);
		this.render();
		this.ctx.onChanged();
	}

	private replace(id: string, patch: Partial<Cover>, remember = true): void {
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
			const active = mode === "draw" || mode === "delete";
			this.captureEl.style.display = active ? "block" : "none";
			this.captureEl.classList.toggle("occ-cursor-delete", mode === "delete");
		}
		this.layerEl.classList.toggle("occ-mode-draw", mode === "draw");
		this.layerEl.classList.toggle("occ-mode-delete", mode === "delete");
		this.layerEl.classList.toggle("occ-mode-reveal", mode === "reveal");
		this.layerEl.classList.toggle("occ-mode-pass", mode === "pass");

		const seen = new Set<string>();
		for (const cover of covers) {
			seen.add(cover.id);
			let el = this.elements.get(cover.id);
			if (!el) {
				el = document.createElement("div");
				el.className = "occ-cover";
				el.addEventListener("click", (e) => {
					if (this.ctx.getMode() !== "reveal") return;
					e.preventDefault();
					e.stopPropagation();
					this.toggle(cover.id);
				});
				el.addEventListener("contextmenu", (e) => {
					if (this.ctx.getMode() === "pass") return;
					e.preventDefault();
					e.stopPropagation();
					this.openMenu(e as MouseEvent, cover.id);
				});
				this.layerEl.appendChild(el);
				this.elements.set(cover.id, el);
			}
			const r = this.toPixels(cover);
			el.style.left = `${offset.left + r.x}px`;
			el.style.top = `${offset.top + r.y}px`;
			el.style.width = `${r.w}px`;
			el.style.height = `${r.h}px`;
			el.style.background = cover.covered ? cover.color : "transparent";
			el.style.opacity = cover.covered ? String(settings.coverOpacity) : "1";
			el.classList.toggle("occ-revealed", !cover.covered);
			el.classList.toggle("occ-marked", !cover.covered && settings.markRevealed);
			el.classList.toggle("occ-selected", mode === "draw" && cover.id === this.selectedId);
			el.style.pointerEvents = mode === "reveal" ? "auto" : "none";
			el.style.borderColor = cover.color;
		}

		for (const [id, el] of this.elements) {
			if (!seen.has(id)) {
				el.remove();
				this.elements.delete(id);
			}
		}
		if (this.selectedId && !seen.has(this.selectedId)) this.selectedId = null;

		this.renderHandles(offset);
	}

	private renderHandles(offset: { left: number; top: number }): void {
		const wanted =
			this.ctx.getMode() === "draw" && this.selectedId
				? this.covers().find((c) => c.id === this.selectedId) ?? null
				: null;

		if (!wanted) {
			this.handleEls.forEach((el) => el.remove());
			this.handleEls = [];
			return;
		}
		if (this.handleEls.length === 0 && this.layerEl) {
			for (const role of HANDLE_ROLES) {
				const el = document.createElement("div");
				el.className = "occ-handle";
				el.dataset.role = role;
				el.style.cursor = HANDLE_CURSORS[role];
				this.layerEl.appendChild(el);
				this.handleEls.push(el);
			}
		}
		const r = this.toPixels(wanted);
		this.handleEls.forEach((el) => {
			const role = el.dataset.role as HandleRole;
			const [hx, hy] = handleAnchor(role, r.x, r.y, r.w, r.h);
			el.style.left = `${offset.left + hx}px`;
			el.style.top = `${offset.top + hy}px`;
		});
	}

	private showPreview(rect: PixelRect | null): void {
		if (!this.previewEl) return;
		if (!rect) {
			this.previewEl.style.display = "none";
			return;
		}
		const offset = this.contentOffset();
		this.previewEl.style.display = "block";
		this.previewEl.style.left = `${offset.left + rect.x}px`;
		this.previewEl.style.top = `${offset.top + rect.y}px`;
		this.previewEl.style.width = `${rect.w}px`;
		this.previewEl.style.height = `${rect.h}px`;
		this.previewEl.style.background = this.ctx.getColor();
	}

	private onPointerDown = (event: PointerEvent): void => {
		if (event.button !== 0 || this.ctx.getMode() !== "draw") return;
		const point = this.pointAt(event);
		this.captureEl?.setPointerCapture(event.pointerId);

		this.dragOrigin = this.covers().map((c) => ({ ...c }));
		const role = this.handleAt(point);
		if (role && this.selectedId) {
			const cover = this.covers().find((c) => c.id === this.selectedId);
			if (cover) {
				this.drag = { kind: "resize", id: cover.id, role, from: point, orig: this.toPixels(cover) };
				return;
			}
		}
		const hit = this.coverAt(point);
		if (hit) {
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
				this.captureEl.style.cursor = role
					? HANDLE_CURSORS[role]
					: this.coverAt(point)
					? "move"
					: "crosshair";
			}
			return;
		}
		const point = this.pointAt(event);
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
		if (!drag) return;
		const point = this.pointAt(event);

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

	/** True when a move or resize actually changed the cover. */
	private movedFrom(drag: Drag): boolean {
		if (drag.kind === "new") return false;
		const current = this.covers().find((c) => c.id === drag.id);
		if (!current) return false;
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
		const hit = this.coverAt(this.pointAt(event));
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
		if (mode !== "draw") return;
		const hit = this.coverAt(this.pointAt(event));
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
		if (this.drag.kind !== "new") {
			this.replace(this.drag.id, this.fromPixels(this.drag.orig), false);
		}
		this.drag = null;
		this.dragOrigin = null;
		this.showPreview(null);
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
