/**
 * Pure text-anchoring helpers shared by text covers.
 *
 * A text cover stores the selected words plus surrounding context. To paint
 * it, the layer searches the currently rendered text for that quote and
 * picks the occurrence whose neighbours best match the stored context.
 *
 * The rendered DOM is not always the whole note: CodeMirror unmounts
 * off-screen lines in Live Preview / Source mode, so the true occurrence
 * can be absent while a duplicate word is visible. Guessing in that case
 * paints the cover over the wrong words and moves it around while
 * scrolling. These helpers therefore demand a confident, unique match and
 * return null otherwise, so an unresolvable cover hides instead of jumping.
 */

export const TEXT_CONTEXT_LENGTH = 120;

/** Best context score must reach this fraction of the stored context. */
export const TEXT_MIN_SCORE_RATIO = 0.75;

/** Minimum lead of the winner over the runner-up; less means ambiguous. */
export const TEXT_TIE_MARGIN = 12;

export interface TextCandidate {
	start: number;
	end: number;
}

/** Collapse every whitespace run to a single space. */
export function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ");
}

/**
 * Collapse whitespace runs and remember where each surviving character
 * came from, so a normalized match maps back to original offsets.
 */
export function normalizeWithMap(text: string): { text: string; map: number[] } {
	const chars: string[] = [];
	const map: number[] = [];
	let i = 0;
	while (i < text.length) {
		if (/\s/.test(text[i])) {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j += 1;
			chars.push(" ");
			map.push(i);
			i = j;
		} else {
			chars.push(text[i]);
			map.push(i);
			i += 1;
		}
	}
	return { text: chars.join(""), map };
}

export function matchingPrefix(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let count = 0;
	while (count < limit && a[count] === b[count]) count += 1;
	return count;
}

export function matchingSuffix(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let count = 0;
	while (count < limit && a[a.length - 1 - count] === b[b.length - 1 - count]) count += 1;
	return count;
}

/**
 * Locate `exact` in `full`, preferring the occurrence whose neighbours best
 * match `prefix`/`suffix`. Returns original-text offsets, or null when no
 * occurrence matches confidently and uniquely.
 */
export function pickTextCandidate(
	full: string,
	exact: string,
	prefix: string,
	suffix: string
): TextCandidate | null {
	const normFull = normalizeWithMap(full);
	const normExact = collapseWhitespace(exact ?? "");
	if (!normExact) return null;
	const normPrefix = collapseWhitespace(prefix ?? "");
	const normSuffix = collapseWhitespace(suffix ?? "");
	const maxScore = normPrefix.length + normSuffix.length;

	let best = -1;
	let bestScore = -1;
	let second = -1;
	for (
		let at = normFull.text.indexOf(normExact);
		at >= 0;
		at = normFull.text.indexOf(normExact, at + 1)
	) {
		const before = normFull.text.slice(Math.max(0, at - normPrefix.length), at);
		const after = normFull.text.slice(
			at + normExact.length,
			at + normExact.length + normSuffix.length
		);
		const score = matchingSuffix(before, normPrefix) + matchingPrefix(after, normSuffix);
		if (score > bestScore) {
			second = bestScore;
			bestScore = score;
			best = at;
		} else if (score > second) {
			second = score;
		}
	}
	if (best < 0) return null;
	if (maxScore > 0) {
		if (bestScore < Math.ceil(maxScore * TEXT_MIN_SCORE_RATIO)) return null;
		if (second >= 0 && bestScore - second < TEXT_TIE_MARGIN) return null;
	}
	const start = normFull.map[best];
	const endIndex = best + normExact.length;
	const end = endIndex < normFull.map.length ? normFull.map[endIndex] : full.length;
	if (start == null || end == null || end <= start) return null;
	return { start, end };
}
