import { setIcon } from "obsidian";
import { MODE_DELETE, MODE_DRAW, MODE_PASS, MODE_REVEAL, MODE_TEXT, Mode } from "./types";

export interface ToolbarHooks {
	getMode(): Mode;
	setMode(mode: Mode): void;
	getColor(): string;
	setColor(color: string): void;
	getSwatches(): string[];
	status(): { count: number; covered: number; note: string | null };
	undo(): void;
	clearNote(): void;
	showAll(): void;
	hideAll(): void;
	addTest(): void;
	close(): void;
}

/** A small draggable panel, the Obsidian counterpart of ToolbarWindow. */
export class OcclusionToolbar {
	private root: HTMLElement;
	private statusEl!: HTMLElement;
	private modeButtons = new Map<Mode, HTMLElement>();
	private colorInput!: HTMLInputElement;
	private hooks: ToolbarHooks;
	private offset = { x: 0, y: 0 };
	private dragging = false;

	constructor(parent: HTMLElement, hooks: ToolbarHooks) {
		this.hooks = hooks;
		this.root = parent.createDiv({ cls: "occ-toolbar" });
		this.build();
		this.refresh();
	}

	private build(): void {
		const header = this.root.createDiv({ cls: "occ-toolbar-header" });
		const grip = header.createSpan({ cls: "occ-grip" });
		setIcon(grip, "grip-horizontal");
		header.createSpan({ cls: "occ-title", text: "Note Occlusion" });
		const close = header.createSpan({ cls: "occ-close" });
		setIcon(close, "x");
		close.addEventListener("click", () => this.hooks.close());
		header.addEventListener("pointerdown", this.onDragStart);

		this.statusEl = this.root.createDiv({ cls: "occ-status" });

		const modes = this.root.createDiv({ cls: "occ-row occ-modes" });
		const modeSpec: Array<[Mode, string, string, string]> = [
			[MODE_DRAW, "Draw", "pencil", "Drag on the note to paint a cover"],
			[MODE_TEXT, "Text", "text-select", "Select text in the note to hide it"],
			[MODE_DELETE, "Delete", "trash-2", "Right-click a cover to remove it"],
			[MODE_REVEAL, "Reveal", "eye", "Click a cover to show what is under it"],
			[MODE_PASS, "Pass", "mouse-pointer", "Covers stay visible, the note works normally"],
		];
		for (const [mode, label, icon, tip] of modeSpec) {
			const btn = modes.createEl("button", { cls: "occ-btn" });
			const iconEl = btn.createSpan();
			setIcon(iconEl, icon);
			btn.createSpan({ text: label });
			btn.setAttribute("aria-label", tip);
			btn.addEventListener("click", () => this.hooks.setMode(mode));
			this.modeButtons.set(mode, btn);
		}

		const colors = this.root.createDiv({ cls: "occ-row occ-colors" });
		this.colorInput = colors.createEl("input", { type: "color", cls: "occ-color" });
		this.colorInput.value = this.hooks.getColor();
		this.colorInput.addEventListener("input", () => {
			this.hooks.setColor(this.colorInput.value);
			this.refresh();
		});
		for (const swatch of this.hooks.getSwatches()) {
			const dot = colors.createDiv({ cls: "occ-swatch" });
			dot.setCssStyles({ background: swatch });
			dot.setAttribute("aria-label", swatch);
			dot.addEventListener("click", () => {
				this.hooks.setColor(swatch);
				this.colorInput.value = swatch;
				this.refresh();
			});
		}

		const actions = this.root.createDiv({ cls: "occ-row" });
		const actionSpec: Array<[string, string, () => void]> = [
			["Undo", "undo-2", () => this.hooks.undo()],
			["Show all", "eye", () => this.hooks.showAll()],
			["Hide all", "eye-off", () => this.hooks.hideAll()],
		];
		for (const [label, icon, fn] of actionSpec) {
			const btn = actions.createEl("button", { cls: "occ-btn" });
			const iconEl = btn.createSpan();
			setIcon(iconEl, icon);
			btn.createSpan({ text: label });
			btn.addEventListener("click", fn);
		}

		const actions2 = this.root.createDiv({ cls: "occ-row" });
		const test = actions2.createEl("button", { cls: "occ-btn" });
		setIcon(test.createSpan(), "square-dashed");
		test.createSpan({ text: "Test cover" });
		test.addEventListener("click", () => this.hooks.addTest());
		const clear = actions2.createEl("button", { cls: "occ-btn occ-danger" });
		setIcon(clear.createSpan(), "trash-2");
		clear.createSpan({ text: "Clear note" });
		clear.addEventListener("click", () => this.hooks.clearNote());

		this.root.createDiv({
			cls: "occ-hint",
			text:
				"Draw: drag to paint, drag a cover to move it, grips to resize. " +
				"Text: select words to create a cover that follows the text. " +
				"Right-click for colour and delete. Delete: right-click a cover to " +
				"remove it immediately. Reveal: click a cover.",
		});
	}

	private onDragStart = (event: PointerEvent): void => {
		if ((event.target as HTMLElement).closest(".occ-close")) return;
		this.dragging = true;
		const rect = this.root.getBoundingClientRect();
		this.offset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
		this.root.setPointerCapture(event.pointerId);
		this.root.addEventListener("pointermove", this.onDragMove);
		this.root.addEventListener("pointerup", this.onDragEnd);
	};

	private onDragMove = (event: PointerEvent): void => {
		if (!this.dragging) return;
		const maxX = window.innerWidth - this.root.offsetWidth - 4;
		const maxY = window.innerHeight - this.root.offsetHeight - 4;
		this.root.setCssStyles({
			left: `${clamp(event.clientX - this.offset.x, 4, maxX)}px`,
			top: `${clamp(event.clientY - this.offset.y, 4, maxY)}px`,
			right: "auto",
		});
	};

	private onDragEnd = (): void => {
		this.dragging = false;
		this.root.removeEventListener("pointermove", this.onDragMove);
		this.root.removeEventListener("pointerup", this.onDragEnd);
	};

	refresh(): void {
		const mode = this.hooks.getMode();
		for (const [key, btn] of this.modeButtons) {
			btn.classList.toggle("occ-active", key === mode);
		}
		const { count, covered, note } = this.hooks.status();
		this.colorInput.value = this.hooks.getColor();
		this.statusEl.empty();
		if (!note) {
			this.statusEl.setText("Open a note to add covers.");
			return;
		}
		this.statusEl.createSpan({ text: `${count} cover${count === 1 ? "" : "s"}` });
		if (count > 0) {
			this.statusEl.createSpan({
				cls: "occ-status-dim",
				text: ` · ${covered} still hidden`,
			});
		}
	}

	destroy(): void {
		this.root.remove();
	}
}

function clamp(value: number, low: number, high: number): number {
	return Math.max(low, Math.min(high, value));
}
