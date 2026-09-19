const assert = require('assert');
const { OcclusionStore } = require('./store.cjs');
const { Plugin, TFile, TFolder } = require('obsidian');

const mk = (id) => ({ id, x: .1, y: 20, w: .3, h: 40, color: '#fff', covered: true });
const textCover = (id) => ({
  id,
  kind: 'text',
  exact: 'selected words',
  prefix: 'before ',
  suffix: ' after',
  color: '#fff',
  covered: true,
});
let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log('  ok -', name); };

(async () => {
  const p = new Plugin();
  const s = new OcclusionStore(p);
  await s.load();

  test('a note starts with no covers', () => assert.deepStrictEqual(s.covers('a.md'), []));

  test('covers persist per note', () => {
    s.set('a.md', [mk('1'), mk('2')]);
    s.set('b.md', [mk('3')]);
    assert.strictEqual(s.count('a.md'), 2);
    assert.strictEqual(s.count('b.md'), 1);
    assert.strictEqual(s.count('c.md'), 0);
  });

  test('undo restores the previous cover set', () => {
    s.set('a.md', [mk('1')]);
    assert.strictEqual(s.count('a.md'), 1);
    assert.ok(s.undo('a.md'));
    assert.strictEqual(s.count('a.md'), 2);
  });

  test('a whole drag collapses into exactly one undo step', () => {
    const snapshot = s.covers('a.md').map(c => ({...c}));
    const before = snapshot.length;
    // what the layer does: many intermediate writes, then one snapshot push
    for (let i = 0; i < 20; i++) s.set('a.md', [mk('x' + i), mk('y' + i)], false);
    s.rememberState('a.md', snapshot);
    assert.strictEqual(s.count('a.md'), 2, 'the drag result is what is stored');
    assert.ok(s.undo('a.md'));
    assert.strictEqual(s.count('a.md'), before, 'one undo reaches the pre-drag state');
    assert.deepStrictEqual(s.covers('a.md').map(c => c.id), snapshot.map(c => c.id));
  });

  test('renaming a note carries its covers', () => {
    s.set('old.md', [mk('9')]);
    s.handleRename(new TFile('new.md'), 'old.md');
    assert.strictEqual(s.count('old.md'), 0);
    assert.strictEqual(s.count('new.md'), 1);
  });

  test('moving a folder re-keys every note inside it', () => {
    s.set('proj/one.md', [mk('a')]);
    s.set('proj/sub/two.md', [mk('b')]);
    s.handleRename(new TFolder('archive/proj'), 'proj');
    assert.strictEqual(s.count('archive/proj/one.md'), 1);
    assert.strictEqual(s.count('archive/proj/sub/two.md'), 1);
    assert.strictEqual(s.count('proj/one.md'), 0);
  });

  test('deleting a note drops its covers', () => {
    s.set('gone.md', [mk('z')]);
    s.handleDelete(new TFile('gone.md'));
    assert.strictEqual(s.count('gone.md'), 0);
  });

  test('emptying a note removes its key entirely', () => {
    s.set('empty.md', [mk('q')]);
    s.set('empty.md', []);
    assert.ok(!s.knownPaths().includes('empty.md'));
  });

  test('prune removes covers for notes that no longer exist', () => {
    s.set('ghost.md', [mk('g')]);
    s.set('real.md', [mk('r')]);
    const removed = s.prune((path) => path === 'real.md');
    assert.ok(removed >= 1);
    assert.strictEqual(s.count('ghost.md'), 0);
    assert.strictEqual(s.count('real.md'), 1);
  });

  test('data survives a reload from disk', async () => {
    await s.forceSave();
    const p2 = new Plugin();
    p2._data = p._data;
    const s2 = new OcclusionStore(p2);
    await s2.load();
    assert.strictEqual(s2.count('real.md'), 1);
  });

  test('text-anchored covers survive a reload', async () => {
    s.set('text.md', [textCover('text-1')]);
    await s.forceSave();
    const p2 = new Plugin();
    p2._data = p._data;
    const s2 = new OcclusionStore(p2);
    await s2.load();
    assert.deepStrictEqual(s2.covers('text.md'), [textCover('text-1')]);
  });

  test('malformed stored entries are discarded, valid ones kept', async () => {
    const p3 = new Plugin();
    p3._data = { version: 1, notes: { 'x.md': [mk('ok'), { id: 'bad' }, null, 5] } };
    const s3 = new OcclusionStore(p3);
    await s3.load();
    assert.strictEqual(s3.count('x.md'), 1);
  });

  console.log(`\n${pass} store checks passed`);
})();
