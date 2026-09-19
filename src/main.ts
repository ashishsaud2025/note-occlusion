import { MarkdownView, Notice, Plugin, TAbstractFile } from "obsidian";
import { LayerContext, OcclusionLayer } from "./layer";
import { OcclusionSettingsTab } from "./settings";
import { OcclusionStore } from "./store";
import { OcclusionToolbar } from "./toolbar";
import {
	Cover,
	MODE_DELETE,
	MODE_DRAW,
	MODE_PASS,
	MODE_REVEAL,
	MODE_TEXT,
	Mode,
} from "./types";

export default class NoteOcclusionPlugin extends Plugin {
	store!: OcclusionStore;
	private mode: Mode = MODE_REVEAL;
	private color = "#ffffff";
	private layers = new Map<MarkdownView, OcclusionLayer>();
	private toolbar: OcclusionToolbar | null = null;
	private statusEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		this.store = new OcclusionStore(this);
		await this.store.load();
		this.mode = this.store.settings.startMode;
		this.color = this.store.settings.defaultColor;

		this.addSettingTab(new OcclusionSettingsTab(this.app, this));
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("occ-statusbar");
		this.statusEl.addEventListener("click", () => this.cycleMode());

		this.addRibbonIcon("square-dashed-bottom", "Note Occlusion", () => this.toggleToolbar());
		this.registerCommands();

		this.registerEvent(this.app.workspace.on("layout-change", () => this.syncLayers()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncLayers()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.syncLayers()));
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				this.store.handleRename(file, oldPath);
				this.syncLayers();
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => this.store.handleDelete(file))
		);
		this.registerDomEvent(document, "keydown", (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (this.mode !== MODE_DRAW && this.mode !== MODE_TEXT && this.mode !== MODE_DELETE) return;
			const layer = this.activeLayer();
			layer?.cancelDrag();
			this.setMode(MODE_REVEAL);
			new Notice("Occlusion: back to reveal mode");
		});

		this.app.workspace.onLayoutReady(() => {
			this.syncLayers();
			if (this.store.settings.showToolbarOnStart) this.toggleToolbar(true);
		});
	}

	onunload(): void {
		this.layers.forEach((layer) => layer.destroy());
		this.layers.clear();
		this.toolbar?.destroy();
		this.toolbar = null;
	}

	private registerCommands(): void {
		this.addCommand({
			id: "toggle-toolbar",
			name: "Toggle the occlusion toolbar",
			callback: () => this.toggleToolbar(),
		});
		this.addCommand({
			id: "cycle-mode",
			name: "Cycle occlusion mode",
			callback: () => this.cycleMode(),
		});
		const modes: Array<[Mode, string]> = [
			[MODE_DRAW, "Draw mode: paint covers"],
			[MODE_TEXT, "Text mode: select text to hide it"],
			[MODE_DELETE, "Delete mode: right-click a cover to remove it"],
			[MODE_REVEAL, "Reveal mode: click covers"],
			[MODE_PASS, "Pass mode: leave the note alone"],
		];
		for (const [mode, name] of modes) {
			this.addCommand({
				id: `mode-${mode}`,
				name,
				callback: () => this.setMode(mode),
			});
		}
		this.addCommand({
			id: "hide-all",
			name: "Hide every cover in this note",
			checkCallback: (checking) => this.withLayer(checking, (l) => l.setAllCovered(true)),
		});
		this.addCommand({
			id: "show-all",
			name: "Reveal every cover in this note",
			checkCallback: (checking) => this.withLayer(checking, (l) => l.setAllCovered(false)),
		});
		this.addCommand({
			id: "undo",
			name: "Undo the last cover change",
			checkCallback: (checking) => {
				const path = this.activePath();
				if (!path || !this.store.canUndo(path)) return false;
				if (!checking) {
					this.store.undo(path);
					this.renderAll();
					this.refreshChrome();
				}
				return true;
			},
		});
		this.addCommand({
			id: "clear-note",
			name: "Delete every cover in this note",
			checkCallback: (checking) =>
				this.withLayer(checking, (layer) => {
					const count = layer.path ? this.store.count(layer.path) : 0;
					layer.clearAll();
					new Notice(`Removed ${count} cover${count === 1 ? "" : "s"}.`);
				}),
		});
		this.addCommand({
			id: "add-test-cover",
			name: "Add a test cover",
			checkCallback: (checking) => this.withLayer(checking, (l) => l.addTestCover()),
		});
	}

	private withLayer(checking: boolean, fn: (layer: OcclusionLayer) => void): boolean {
		const layer = this.activeLayer();
		if (!layer || !layer.path) return false;
		if (!checking) {
			fn(layer);
			this.refreshChrome();
		}
		return true;
	}

	private layerContext(): LayerContext {
		return {
			getMode: () => this.mode,
			getColor: () => this.color,
			getSettings: () => this.store.settings,
			getCovers: (path: string) => this.store.covers(path),
			setCovers: (path: string, covers: Cover[], remember = true) =>
				this.store.set(path, covers, remember),
			rememberState: (path: string, covers: Cover[]) =>
				this.store.rememberState(path, covers),
			onChanged: () => this.refreshChrome(),
		};
	}

	/** Build a layer for every open markdown view, drop the rest. */
	syncLayers(): void {
		const live = new Set<MarkdownView>();
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			live.add(view);
			const existing = this.layers.get(view);
			if (existing && !existing.isStale()) {
				existing.scheduleRender();
				continue;
			}
			existing?.destroy();
			const layer = new OcclusionLayer(view, this.layerContext());
			if (layer.attach()) {
				this.layers.set(view, layer);
			} else {
				this.layers.delete(view);
			}
		}
		for (const [view, layer] of this.layers) {
			if (!live.has(view)) {
				layer.destroy();
				this.layers.delete(view);
			}
		}
		this.refreshChrome();
	}

	private activeLayer(): OcclusionLayer | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return null;
		return this.layers.get(view) ?? null;
	}

	private activePath(): string | null {
		return this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? null;
	}

	renderAll(): void {
		this.layers.forEach((layer) => layer.scheduleRender());
	}

	setMode(mode: Mode): void {
		this.mode = mode;
		this.renderAll();
		this.refreshChrome();
	}

	cycleMode(): void {
		const order: Mode[] = [MODE_REVEAL, MODE_DRAW, MODE_TEXT, MODE_DELETE, MODE_PASS];
		const next = order[(order.indexOf(this.mode) + 1) % order.length];
		this.setMode(next);
	}

	setColor(color: string): void {
		this.color = color;
		this.refreshChrome();
	}

	private refreshChrome(): void {
		const path = this.activePath();
		const covers = this.store.covers(path);
		if (this.statusEl) {
			const hidden = covers.filter((c) => c.covered).length;
			this.statusEl.setText(
				covers.length === 0
					? `Occlusion: ${this.mode}`
					: `Occlusion: ${this.mode} · ${hidden}/${covers.length} hidden`
			);
			this.statusEl.setAttribute("aria-label", "Click to change occlusion mode");
		}
		this.toolbar?.refresh();
	}

	toggleToolbar(force?: boolean): void {
		const wanted = force ?? this.toolbar === null;
		if (!wanted) {
			this.toolbar?.destroy();
			this.toolbar = null;
			return;
		}
		if (this.toolbar) return;
		this.toolbar = new OcclusionToolbar(document.body, {
			getMode: () => this.mode,
			setMode: (mode) => this.setMode(mode),
			getColor: () => this.color,
			setColor: (color) => this.setColor(color),
			getSwatches: () => this.store.settings.swatches,
			status: () => {
				const path = this.activePath();
				const covers = this.store.covers(path);
				return {
					count: covers.length,
					covered: covers.filter((c) => c.covered).length,
					note: path,
				};
			},
			undo: () => {
				const path = this.activePath();
				if (path && this.store.undo(path)) {
					this.renderAll();
					this.refreshChrome();
				}
			},
			clearNote: () => {
				const layer = this.activeLayer();
				if (layer) {
					layer.clearAll();
					this.refreshChrome();
				}
			},
			showAll: () => this.activeLayer()?.setAllCovered(false),
			hideAll: () => this.activeLayer()?.setAllCovered(true),
			addTest: () => this.activeLayer()?.addTestCover(),
			close: () => this.toggleToolbar(false),
		});
		this.refreshChrome();
	}
}
