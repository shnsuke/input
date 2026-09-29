import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, parseTags, filterEntries, highlight, mergeEntries, parseRemoteFile, buildRemoteFile } from '../js/core.js';

const E = (o) => ({ id: o.id, title: '', body: '', tags: [], url: '', type: '本', date: '2026-01-01', updatedAt: '2026-01-01T00:00:00.000Z', deleted: false, ...o });

test('normalize: 全角半角・大小文字・カタカナを同一視', () => {
  assert.equal(normalize('ＡＢＣ abc'), 'abc abc');
  assert.equal(normalize('マーケティング'), normalize('まーけてぃんぐ'));
  assert.equal(normalize('ｶﾀｶﾅ'), 'かたかな');
});

test('parseTags', () => {
  assert.deepEqual(parseTags('a, b　#c、a'), ['a', 'b', 'c']);
  assert.deepEqual(parseTags(''), []);
});

test('filterEntries: キーワード AND・日付範囲・種類・タグ', () => {
  const list = [
    E({ id: '1', title: 'React入門', body: 'フックの使い方', tags: ['技術'], date: '2026-03-01' }),
    E({ id: '2', title: '習慣の本', body: 'react という単語', type: '記事', date: '2026-04-10' }),
    E({ id: '3', title: '削除済み react', deleted: true }),
  ];
  assert.deepEqual(filterEntries(list, { q: 'ＲＥＡＣＴ' }).map((e) => e.id), ['2', '1']);
  assert.deepEqual(filterEntries(list, { q: 'react ふっく' }).map((e) => e.id), ['1']);
  assert.deepEqual(filterEntries(list, { from: '2026-04-01' }).map((e) => e.id), ['2']);
  assert.deepEqual(filterEntries(list, { to: '2026-03-31' }).map((e) => e.id), ['1']);
  assert.deepEqual(filterEntries(list, { type: '記事' }).map((e) => e.id), ['2']);
  assert.deepEqual(filterEntries(list, { tag: '技術' }).map((e) => e.id), ['1']);
});

test('highlight: 正規化して一致した箇所を元の文字でマークし、HTML をエスケープ', () => {
  assert.equal(highlight('<b>ＲＥＡＣＴ</b>', ['react']), '&lt;b&gt;<mark>ＲＥＡＣＴ</mark>&lt;/b&gt;');
  assert.equal(highlight('カタカナ', ['かな']), 'カタ<mark>カナ</mark>');
  assert.equal(highlight('abc', []), 'abc');
});

test('mergeEntries: 新しい方を採用し、双方向に反映する', () => {
  const local = [
    E({ id: 'a', title: 'local-new', updatedAt: '2026-02-02T00:00:00Z', dirty: true }),
    E({ id: 'b', title: 'local-old', updatedAt: '2026-01-01T00:00:00Z' }),
    E({ id: 'c', title: 'local-only', dirty: true }),
  ];
  const remote = [
    E({ id: 'a', title: 'remote-old', updatedAt: '2026-01-01T00:00:00Z' }),
    E({ id: 'b', title: 'remote-new', updatedAt: '2026-03-03T00:00:00Z' }),
    E({ id: 'd', title: 'remote-only' }),
  ];
  const { merged, toSaveLocal, remoteChanged } = mergeEntries(local, remote);
  const m = Object.fromEntries(merged.map((e) => [e.id, e.title]));
  assert.deepEqual(m, { a: 'local-new', b: 'remote-new', c: 'local-only', d: 'remote-only' });
  assert.deepEqual(toSaveLocal.map((e) => e.id).sort(), ['b', 'd']);
  assert.equal(remoteChanged, true);
  assert.ok(merged.every((e) => !('dirty' in e)), '同期ファイルに dirty を含めない');
});

test('mergeEntries: 削除も新しければ伝播する', () => {
  const local = [E({ id: 'x', deleted: true, updatedAt: '2026-05-01T00:00:00Z', dirty: true })];
  const remote = [E({ id: 'x', title: 'まだある', updatedAt: '2026-04-01T00:00:00Z' })];
  const { merged } = mergeEntries(local, remote);
  assert.equal(merged[0].deleted, true);
});

test('mergeEntries: 同じ内容なら書き込み不要', () => {
  const same = [E({ id: 'a', title: 't' })];
  const r = mergeEntries(same, same);
  assert.equal(r.remoteChanged, false);
  assert.equal(r.toSaveLocal.length, 0);
});

test('parseRemoteFile / buildRemoteFile', () => {
  const f = JSON.stringify(buildRemoteFile([E({ id: 'a' })]));
  assert.equal(parseRemoteFile(f)[0].id, 'a');
  assert.throws(() => parseRemoteFile('{"x":1}'));
});
