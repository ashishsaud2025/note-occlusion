export type Mode = "draw" | "text" | "delete" | "reveal" | "pass";

export const MODE_DRAW: Mode = "draw";
export const MODE_TEXT: Mode = "text";
export const MODE_DELETE: Mode = "delete";
export const MODE_REVEAL: Mode = "reveal";
export const MODE_PASS: Mode = "pass";

/**
 * One cover painted over a note.
 *
 * x and w are fractions of the note's content width, so covers keep their
 * place when the pane is resized or the window changes shape. y and h are
 * pixels from the top of the note's content, which is stable while the text
 * above them does not change length.
 */
interface CoverBase {
	id: string;
	color: string;
	covered: boolean;
}

export interface RectangleCover extends CoverBase {
	kind?: "rectangle";
	x: number;
	y: number;
	w: number;
	h: number;
}

/** A quote that is located again in whichever renderer is currently visible. */
export interface TextCover extends CoverBase {
	kind: "text";
	exact: string;
	prefix: string;
	suffix: string;
}

export type Cover = RectangleCover | TextCover;

export function isTextCover(cover: Cover): cover is TextCover {
	return cover.kind === "text";
}

export interface OcclusionSettings {
	defaultColor: string;
	startMode: Mode;
	showToolbarOnStart: boolean;
	markRevealed: boolean;
	coverOpacity: number;
	swatches: string[];
}

export const DEFAULT_SETTINGS: OcclusionSettings = {
	defaultColor: "#ffffff",
	startMode: "reveal",
	showToolbarOnStart: false,
	markRevealed: true,
	coverOpacity: 1,
	swatches: ["#ffffff", "#1e1e1e", "#ffd166", "#06d6a0", "#ef476f", "#4f9be0"],
};

export interface OcclusionData {
	version: 1;
	settings: OcclusionSettings;
	notes: Record<string, Cover[]>;
}

export const HANDLE_ROLES = ["tl", "t", "tr", "l", "r", "bl", "b", "br"] as const;
export type HandleRole = (typeof HANDLE_ROLES)[number];

export const HANDLE_SIZE = 12;
export const MIN_SIZE = 12;

export const HANDLE_CURSORS: Record<HandleRole, string> = {
	tl: "nwse-resize",
	br: "nwse-resize",
	tr: "nesw-resize",
	bl: "nesw-resize",
	l: "ew-resize",
	r: "ew-resize",
	t: "ns-resize",
	b: "ns-resize",
};

/** Top-left pixel position of a handle box centred on its anchor point. */
export function handleAnchor(
	role: HandleRole,
	x: number,
	y: number,
	w: number,
	h: number
): [number, number] {
	const half = HANDLE_SIZE / 2;
	const anchors: Record<HandleRole, [number, number]> = {
		tl: [x, y],
		t: [x + w / 2, y],
		tr: [x + w, y],
		l: [x, y + h / 2],
		r: [x + w, y + h / 2],
		bl: [x, y + h],
		b: [x + w / 2, y + h],
		br: [x + w, y + h],
	};
	const [ax, ay] = anchors[role];
	return [ax - half, ay - half];
}

/** New pixel rect when dragging `role` by (dx, dy). */
export function applyRoleResize(
	role: HandleRole,
	ox: number,
	oy: number,
	ow: number,
	oh: number,
	dx: number,
	dy: number
): [number, number, number, number] {
	let nx = ox;
	let ny = oy;
	let nw = ow;
	let nh = oh;
	if (role === "r" || role === "tr" || role === "br") {
		nw = Math.max(MIN_SIZE, ow + dx);
	}
	if (role === "l" || role === "tl" || role === "bl") {
		nw = Math.max(MIN_SIZE, ow - dx);
		nx = ox + (ow - nw);
	}
	if (role === "b" || role === "bl" || role === "br") {
		nh = Math.max(MIN_SIZE, oh + dy);
	}
	if (role === "t" || role === "tl" || role === "tr") {
		nh = Math.max(MIN_SIZE, oh - dy);
		ny = oy + (oh - nh);
	}
	return [nx, ny, nw, nh];
}

/** Readable text colour for a background, mirroring text_color_for(). */
export function textColorFor(hex: string): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return "#000000";
	const n = parseInt(m[1], 16);
	const r = (n >> 16) & 255;
	const g = (n >> 8) & 255;
	const b = n & 255;
	// same lightness measure QColor uses: midpoint of the largest and
	// smallest channel
	const lightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
	return lightness > 128 ? "#000000" : "#ffffff";
}

export function randomId(): string {
	return Math.random().toString(36).slice(2, 10);
}
