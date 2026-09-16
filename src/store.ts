import { Plugin, TAbstractFile, TFile, debounce } from "obsidian";
import { Cover, DEFAULT_SETTINGS, OcclusionData, OcclusionSettings } from "./types";

const MAX_UNDO = 50;

/**
 * Holds every note's covers and writes them to the plugin's data.json.
 *
 * Covers are keyed by vault path. Renames and deletes are followed so a note
 * does not lose its covers when it moves.
 */
export class OcclusionStore {
	private plugin: Plugin;
	private data: OcclusionData;
	private undoStacks = new Map<string, Cover[][]>();
	private flush: () => void;

	constructor(plugin: Plugin) {
		this.plugin = plugin;
		this.data = { version: 1, settings: { ...DEFAULT_SETTINGS }, notes: {} };
		this.flush = debounce(() => void this.plugin.saveData(this.data), 400, true);
	}

	async load(): Promise<void> {
		const raw = (await this.plugin.loadData()) as Partial<OcclusionData> | null;
		if (!raw) return;
		this.data.settings = { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) };
		const notes = raw.notes ?? {};
		for (const [path, covers] of Object.entries(notes)) {
			if (Array.isArray(covers)) {
				this.data.notes[path] = covers.filter(isCover);
			}
		}
	}

	get settings(): OcclusionSettings {
		return this.data.settings;
	}

	async saveSettings(): Promise<void> {
		await this.plugin.saveData(this.data);
	}

	covers(path: string | null): Cover[] {
		if (!path) return [];
		return this.data.notes[path] ?? [];
	}

	count(path: string | null): number {
		return this.covers(path).length;
	}

	/** Replace a note's covers. Pass remember=false for continuous drags. */
	set(path: string, covers: Cover[], remember = true): void {
		if (remember) this.pushUndo(path);
		if (covers.length === 0) {
			delete this.data.notes[path];
		} else {
			this.data.notes[path] = covers;
		}
		this.flush();
	}

	/**
	 * Record a snapshot to undo back to.
	 *
	 * A drag writes many intermediate states with remember=false so the undo
	 * stack does not fill with one entry per mouse move. The caller hands the
	 * pre-drag state here once, when the drag ends.
	 */
	rememberState(path: string, covers: Cover[]): void {
		const stack = this.undoStacks.get(path) ?? [];
		stack.push(clone(covers));
		if (stack.length > MAX_UNDO) stack.shift();
		this.undoStacks.set(path, stack);
	}

	private pushUndo(path: string): void {
		const stack = this.undoStacks.get(path) ?? [];
		stack.push(clone(this.covers(path)));
		if (stack.length > MAX_UNDO) stack.shift();
		this.undoStacks.set(path, stack);
	}

	canUndo(path: string | null): boolean {
		return !!path && (this.undoStacks.get(path)?.length ?? 0) > 0;
	}

	undo(path: string): boolean {
		const stack = this.undoStacks.get(path);
		if (!stack || stack.length === 0) return false;
		const previous = stack.pop() as Cover[];
		if (previous.length === 0) {
			delete this.data.notes[path];
		} else {
			this.data.notes[path] = previous;
		}
		this.flush();
		return true;
	}

	/** Notes that currently have covers, for the "clean up" command. */
	knownPaths(): string[] {
		return Object.keys(this.data.notes);
	}

	handleRename(file: TAbstractFile, oldPath: string): void {
		if (!(file instanceof TFile)) {
			// a folder moved: re-key every note inside it
			const prefix = oldPath + "/";
			for (const path of Object.keys(this.data.notes)) {
				if (path.startsWith(prefix)) {
					const moved = file.path + "/" + path.slice(prefix.length);
					this.data.notes[moved] = this.data.notes[path];
					delete this.data.notes[path];
				}
			}
			this.flush();
			return;
		}
		const covers = this.data.notes[oldPath];
		if (!covers) return;
		this.data.notes[file.path] = covers;
		delete this.data.notes[oldPath];
		const stack = this.undoStacks.get(oldPath);
		if (stack) {
			this.undoStacks.set(file.path, stack);
			this.undoStacks.delete(oldPath);
		}
		this.flush();
	}

	handleDelete(file: TAbstractFile): void {
		if (file instanceof TFile) {
			delete this.data.notes[file.path];
		} else {
			const prefix = file.path + "/";
			for (const path of Object.keys(this.data.notes)) {
				if (path.startsWith(prefix)) delete this.data.notes[path];
			}
		}
		this.flush();
	}

	/** Drop covers whose note no longer exists. */
	prune(exists: (path: string) => boolean): number {
		let removed = 0;
		for (const path of Object.keys(this.data.notes)) {
			if (!exists(path)) {
				delete this.data.notes[path];
				removed += 1;
			}
		}
		if (removed) this.flush();
		return removed;
	}

	async forceSave(): Promise<void> {
		await this.plugin.saveData(this.data);
	}
}

function clone(covers: Cover[]): Cover[] {
	return covers.map((c) => ({ ...c }));
}

function isCover(value: unknown): value is Cover {
	if (!value || typeof value !== "object") return false;
	const c = value as Record<string, unknown>;
	return (
		typeof c.id === "string" &&
		typeof c.x === "number" &&
		typeof c.y === "number" &&
		typeof c.w === "number" &&
		typeof c.h === "number" &&
		typeof c.color === "string" &&
		typeof c.covered === "boolean"
	);
}
