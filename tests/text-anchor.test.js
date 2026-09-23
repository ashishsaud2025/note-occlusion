const assert = require('assert');
const {
  TEXT_MIN_SCORE_RATIO,
  TEXT_TIE_MARGIN,
  collapseWhitespace,
  normalizeWithMap,
  pickTextCandidate,
} = require('./text-anchor.cjs');

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log('  ok -', name); };

const DEF = 'A distributed system is a collection of independent computers that communicate by passing messages.';
const EXAMPLE = 'Independent nodes coordinate purely by exchanging messages for travelers.';
const NOTE = `${DEF}\n\n${EXAMPLE}`;

const around = (text, exact) => {
  const at = text.indexOf(exact);
  assert.ok(at >= 0, `fixture must contain ${exact}`);
  return {
    prefix: text.slice(Math.max(0, at - 120), at),
    suffix: text.slice(at + exact.length, at + exact.length + 120),
  };
};

test('a unique match resolves to its offsets', () => {
  const hit = pickTextCandidate(NOTE, 'distributed system', 'A ', ' is a collection');
  assert.ok(hit);
  assert.strictEqual(NOTE.slice(hit.start, hit.end), 'distributed system');
});

test('a repeated word resolves to the occurrence its context came from', () => {
  const { prefix, suffix } = around(DEF, 'messages');
  const hit = pickTextCandidate(NOTE, 'messages', prefix, suffix);
  assert.ok(hit);
  assert.ok(hit.start < DEF.length, 'matches inside the definition, not the example');
  assert.strictEqual(NOTE.slice(hit.start, hit.end), 'messages');
});

test('when the true occurrence is scrolled away the cover hides instead of jumping', () => {
  // CodeMirror unmounts off-screen lines: only the example text is searchable.
  const { prefix, suffix } = around(DEF, 'messages');
  const hit = pickTextCandidate(EXAMPLE, 'messages', prefix, suffix);
  assert.strictEqual(hit, null);
});

test('identical contexts stay hidden instead of guessing an occurrence', () => {
  const repeated = 'ab word cd ab word cd';
  const hit = pickTextCandidate(repeated, 'word', 'ab ', ' cd');
  assert.strictEqual(hit, null);
});

test('whitespace runs collapse and map back to original offsets', () => {
  const full = 'single   coherent\tsystem';
  const normed = normalizeWithMap(full);
  assert.strictEqual(normed.text, 'single coherent system');
  const hit = pickTextCandidate(full, 'coherent system', 'single ', '');
  assert.ok(hit);
  assert.strictEqual(full.slice(hit.start, hit.end), 'coherent\tsystem');
});

test('an end-of-text match maps its end to the full length', () => {
  const hit = pickTextCandidate(NOTE, 'travelers.', 'messages for ', '');
  assert.ok(hit);
  assert.strictEqual(hit.end, NOTE.length);
});

test('empty quotes and missing words never match', () => {
  assert.strictEqual(pickTextCandidate(NOTE, '', 'a', 'b'), null);
  assert.strictEqual(pickTextCandidate(NOTE, '   ', 'a', 'b'), null);
  assert.strictEqual(pickTextCandidate(NOTE, 'quorum', 'a', 'b'), null);
});

test('a bare quote with no context takes the first match', () => {
  const hit = pickTextCandidate('messages and messages', 'messages', '', '');
  assert.deepStrictEqual(hit, { start: 0, end: 8 });
});

test('collapseWhitespace is used consistently for stored and rendered text', () => {
  assert.strictEqual(collapseWhitespace('a\n\nb\tc'), 'a b c');
  assert.ok(TEXT_MIN_SCORE_RATIO > 0.5 && TEXT_TIE_MARGIN > 0);
});

console.log(`\n${pass} text-anchor checks passed`);
