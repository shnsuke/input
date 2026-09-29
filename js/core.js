// DOM や IndexedDB に依存しない純粋なロジック（Node のテストからも読み込む）

/** 同期ファイルの形式バージョン */
export const FORMAT_VERSION = 1;

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function todayString(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "a, b　#c" → ["a","b","c"]（重複除去） */
export function parseTags(text) {
  const tags = String(text || '')
    .split(/[,\s、，　]+/)
    .map((t) => t.replace(/^#/, '').trim())
    .filter(Boolean);
  return [...new Set(tags)];
}

// ---------------------------------------------------------------- 検索

function kataToHira(ch) {
  const c = ch.charCodeAt(0);
  return c >= 0x30a1 && c <= 0x30f6 ? String.fromCharCode(c - 0x60) : ch;
}

function normChar(ch) {
  return [...ch.normalize('NFKC').toLowerCase()].map(kataToHira).join('');
}

/** 検索用に正規化（全角/半角・大文字/小文字・カタカナ/ひらがなを同一視） */
export function normalize(text) {
  let out = '';
  for (const ch of String(text || '')) out += normChar(ch);
  return out;
}

/** 正規化文字列と、その各位置が元文字列のどこに対応するかの表を作る */
function normalizeWithMap(text) {
  let norm = '';
  const map = []; // norm の i 文字目 → 元文字列の [start, end)
  let pos = 0;
  for (const ch of String(text || '')) {
    const n = normChar(ch);
    for (let i = 0; i < n.length; i++) map.push([pos, pos + ch.length]);
    norm += n;
    pos += ch.length;
  }
  return { norm, map };
}

export function parseQuery(q) {
  return normalize(q).split(/\s+/).filter(Boolean);
}

export function entryHaystack(e) {
  return normalize([e.title, e.body, (e.tags || []).join(' '), e.url, e.type].join('\n'));
}

/**
 * @param {object[]} entries
 * @param {{q?:string, from?:string, to?:string, type?:string, tag?:string}} f
 */
export function filterEntries(entries, f = {}) {
  const terms = parseQuery(f.q || '');
  const res = entries.filter((e) => {
    if (e.deleted) return false;
    if (f.from && e.date < f.from) return false;
    if (f.to && e.date > f.to) return false;
    if (f.type && e.type !== f.type) return false;
    if (f.tag && !(e.tags || []).includes(f.tag)) return false;
    if (terms.length) {
      const hay = entryHaystack(e);
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
  // 日付の新しい順 → 更新の新しい順
  res.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return res;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** キーワードを <mark> で囲んだ安全な HTML を返す */
export function highlight(text, terms) {
  text = String(text ?? '');
  if (!terms.length || !text) return escapeHtml(text);
  const { norm, map } = normalizeWithMap(text);
  const ranges = [];
  for (const t of terms) {
    let i = norm.indexOf(t);
    while (i !== -1) {
      ranges.push([map[i][0], map[i + t.length - 1][1]]);
      i = norm.indexOf(t, i + t.length);
    }
  }
  if (!ranges.length) return escapeHtml(text);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (const r of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push(r);
  }
  let out = '';
  let p = 0;
  for (const [s, e] of merged) {
    out += escapeHtml(text.slice(p, s)) + '<mark>' + escapeHtml(text.slice(s, e)) + '</mark>';
    p = e;
  }
  return out + escapeHtml(text.slice(p));
}

// ---------------------------------------------------------------- 同期

/** 端末内でのみ使うフィールドを落として同期用の形にする */
export function toRemote(e) {
  const { dirty, ...rest } = e;
  return rest;
}

function isNewer(a, b) {
  return (a.updatedAt || '') > (b.updatedAt || '');
}

/**
 * 端末内のデータと Drive のデータをエントリ単位でマージする。
 * 更新日時が新しい方を採用（削除は deleted フラグ付きの記録として残るので削除も伝播する）。
 *
 * @returns {{ merged: object[], toSaveLocal: object[], remoteChanged: boolean }}
 *   merged: Drive に書き込むべき全エントリ
 *   toSaveLocal: 端末側に取り込むべきエントリ（Drive 側が新しかったもの）
 *   remoteChanged: Drive の内容を書き換える必要があるか
 */
export function mergeEntries(local, remote) {
  const byId = new Map();
  for (const r of remote) byId.set(r.id, toRemote(r));
  const toSaveLocal = [];
  let remoteChanged = false;
  const localIds = new Set();

  for (const l of local) {
    localIds.add(l.id);
    const r = byId.get(l.id);
    if (!r || isNewer(l, r)) {
      byId.set(l.id, toRemote(l));
      remoteChanged = true;
    } else if (isNewer(r, l)) {
      toSaveLocal.push(r);
    }
  }
  for (const r of byId.values()) {
    if (!localIds.has(r.id)) toSaveLocal.push(r);
  }
  return { merged: [...byId.values()], toSaveLocal, remoteChanged };
}

export function buildRemoteFile(entries) {
  return { app: 'input-log', version: FORMAT_VERSION, updatedAt: new Date().toISOString(), entries };
}

export function parseRemoteFile(json) {
  if (!json) return [];
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (Array.isArray(data)) return data; // 念のため配列だけのファイルも受け付ける
  if (!Array.isArray(data.entries)) throw new Error('同期ファイルの形式が不正です');
  return data.entries.filter((e) => e && e.id);
}
