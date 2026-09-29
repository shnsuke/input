import * as db from './db.js';
import * as drive from './drive.js';
import { syncNow, isSyncing } from './sync.js';
import { GOOGLE_CLIENT_ID } from './config.js';
import { MAX_FILE_BYTES, isImage, isVideo, formatSize, prepareImage } from './media.js';
import { newId, todayString, parseTags, filterEntries, parseQuery, highlight, escapeHtml, parseRemoteFile, buildRemoteFile, toRemote } from './core.js';

const $ = (sel) => document.querySelector(sel);
const CLIENT_ID_KEY = 'inputlog.clientId';
const AUTO_SYNC_MS = 5 * 60 * 1000;

let entries = [];
let activeTag = '';
let lastSyncAt = null;
let formMedia = []; // フォームで編集中の添付 [{id,name,type,size,driveId?,blob?}]
let originalMedia = []; // 編集開始時点の添付（削除された分を判定するため）
const urlCache = new Map(); // 添付id → 表示用 Blob URL

const form = $('#entry-form');
const searchForm = $('#search-form');
const F = form.elements;
const S = searchForm.elements;

// ------------------------------------------------------------ 共通

function clientId() {
  return localStorage.getItem(CLIENT_ID_KEY) || GOOGLE_CLIENT_ID;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function pendingCount() {
  return entries.filter((e) => e.dirty).length;
}

async function reload() {
  entries = await db.getAllEntries();
  renderResults();
  renderTags();
  renderStatus();
}

// ------------------------------------------------------------ 状態表示

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderStatus() {
  const online = navigator.onLine;
  const net = $('#net-status');
  net.textContent = online ? 'オンライン' : 'オフライン';
  net.classList.toggle('warn', !online);

  const n = pendingCount();
  const pend = $('#pending-status');
  if (isSyncing()) {
    pend.textContent = '同期中…';
    pend.classList.remove('warn');
  } else if (n) {
    pend.textContent = `未同期 ${n}件`;
    pend.classList.add('warn');
  } else {
    pend.textContent = lastSyncAt ? `同期済み ${fmtTime(lastSyncAt)}` : '';
    pend.classList.remove('warn');
  }
  $('#sync-btn').disabled = !online || isSyncing();

  // オンライン復帰したがトークン切れで自動同期できない場合の案内
  const banner = $('#banner');
  if (online && n && clientId() && drive.wasConnected() && !drive.hasValidToken()) {
    banner.innerHTML = `<span>オンラインです。未同期の記録が ${n} 件あります。</span><button type="button" class="btn small primary" id="banner-sync">Google ドライブに同期</button>`;
    banner.hidden = false;
    $('#banner-sync').onclick = () => manualSync();
  } else if (online && n && !drive.wasConnected()) {
    banner.innerHTML = `<span>Google ドライブに未接続です（記録は端末内に保存されています）。</span><button type="button" class="btn small" id="banner-setup">接続する</button>`;
    banner.hidden = false;
    $('#banner-setup').onclick = () => openSettings();
  } else {
    banner.hidden = true;
  }

  const acct = $('#account-status');
  if (acct) {
    acct.textContent = drive.hasValidToken()
      ? '接続中'
      : drive.wasConnected()
        ? '接続の有効期限切れ（同期時に再接続します）'
        : '未接続';
  }
}

// ------------------------------------------------------------ 同期

async function runSync({ quiet = true } = {}) {
  if (!navigator.onLine || isSyncing()) return;
  const p = syncNow();
  renderStatus();
  try {
    const r = await p;
    lastSyncAt = r.at;
    if (r.media?.failed) toast(`写真・動画 ${r.media.failed} 件をアップロードできませんでした（${r.media.error}）。次回の同期で再試行します`);
    else if (!quiet || r.pulled) toast(r.pulled ? `同期しました（${r.pulled}件を取り込み）` : '同期しました');
  } catch (e) {
    if (!quiet || !(e instanceof drive.AuthRequiredError)) toast(e.message);
    console.warn(e);
  } finally {
    await reload();
  }
}

/** 自動同期：トークンが有効なときだけ（ポップアップは出さない） */
function autoSync() {
  if (navigator.onLine && drive.hasValidToken()) runSync();
  else renderStatus();
}

let debounce;
function scheduleSync() {
  clearTimeout(debounce);
  debounce = setTimeout(autoSync, 1500);
}

/** ボタン操作からの同期：必要なら Google の許可を求める */
async function manualSync() {
  if (!drive.hasValidToken() && !clientId()) {
    toast('先に Google ドライブ連携を設定してください');
    return openSettings();
  }
  try {
    if (!drive.hasValidToken()) await drive.signIn(clientId());
  } catch (e) {
    return toast(e.message);
  }
  await runSync({ quiet: false });
}

// ------------------------------------------------------------ 入力フォーム

function resetForm() {
  form.reset();
  F.id.value = '';
  F.date.value = todayString();
  $('#save-btn').textContent = '保存';
  $('#cancel-edit').hidden = true;
  formMedia = [];
  originalMedia = [];
  renderFormMedia();
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const now = new Date().toISOString();
  const id = F.id.value;
  const prev = id ? entries.find((e) => e.id === id) : null;
  const entry = {
    id: id || newId(),
    date: F.date.value || todayString(),
    type: F.type.value,
    title: F.title.value.trim(),
    body: F.body.value.trim(),
    tags: parseTags(F.tags.value),
    url: F.url.value.trim(),
    attachments: formMedia.map(({ id, name, type, size, driveId }) => ({ id, name, type, size, ...(driveId ? { driveId } : {}) })),
    createdAt: prev?.createdAt || now,
    updatedAt: now,
    deleted: false,
    dirty: true,
  };
  if (!entry.title) return toast('タイトルを入力してください');
  // 写真・動画の本体を先に保存してから記録を保存する
  for (const m of formMedia) if (m.blob) await db.putFile({ id: m.id, name: m.name, type: m.type, size: m.size, blob: m.blob });
  await db.putEntry(entry);
  await discardMedia(originalMedia.filter((o) => !formMedia.some((m) => m.id === o.id)));
  resetForm();
  toast(navigator.onLine ? '保存しました' : '端末に保存しました（オンライン復帰時に同期します）');
  await reload();
  scheduleSync();
});

$('#cancel-edit').addEventListener('click', resetForm);

function startEdit(e) {
  F.id.value = e.id;
  F.date.value = e.date;
  F.type.value = e.type || 'その他';
  F.title.value = e.title;
  F.body.value = e.body || '';
  F.tags.value = (e.tags || []).join(' ');
  F.url.value = e.url || '';
  formMedia = (e.attachments || []).map((a) => ({ ...a }));
  originalMedia = (e.attachments || []).map((a) => ({ ...a }));
  renderFormMedia();
  $('#save-btn').textContent = '更新';
  $('#cancel-edit').hidden = false;
  form.scrollIntoView({ behavior: 'smooth' });
  F.title.focus({ preventScroll: true });
}

async function removeEntry(e) {
  if (!confirm(`「${e.title}」を削除しますか？`)) return;
  // 他の端末にも削除を伝えるため、中身を消した「削除済み」記録として残す
  await discardMedia(e.attachments || []);
  await db.putEntry({ id: e.id, deleted: true, createdAt: e.createdAt, updatedAt: new Date().toISOString(), dirty: true, title: '', body: '', tags: [], date: e.date });
  if (F.id.value === e.id) resetForm();
  toast('削除しました');
  await reload();
  scheduleSync();
}

// ------------------------------------------------------------ 写真・動画

function newAttachmentId() {
  return newId().replace(/-/g, '').slice(0, 16);
}

/** 削除した添付の本体を端末から消し、Drive 側は次回の同期で消す */
async function discardMedia(list) {
  if (!list.length) return;
  const pending = (await db.getMeta('pendingDeletes')) || [];
  for (const a of list) {
    if (a.driveId) pending.push(a.driveId);
    await db.deleteFile(a.id);
    const u = urlCache.get(a.id);
    if (u) URL.revokeObjectURL(u);
    urlCache.delete(a.id);
  }
  await db.setMeta('pendingDeletes', pending);
}

$('#media-input').addEventListener('change', async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = '';
  for (const f of files) {
    if (!isImage(f.type) && !isVideo(f.type)) {
      toast(`「${f.name}」は写真・動画ではないため追加できません`);
      continue;
    }
    if (f.size > MAX_FILE_BYTES) {
      toast(`「${f.name}」は大きすぎます（上限 ${formatSize(MAX_FILE_BYTES)}）`);
      continue;
    }
    const blob = await prepareImage(f);
    formMedia.push({ id: newAttachmentId(), name: blob.name || f.name, type: blob.type || f.type, size: blob.size, blob });
  }
  renderFormMedia();
});

function renderFormMedia() {
  const ul = $('#form-media');
  ul.innerHTML = '';
  for (const m of formMedia) {
    const li = document.createElement('li');
    const url = m.blob ? URL.createObjectURL(m.blob) : urlCache.get(m.id);
    const thumb = isImage(m.type) && url ? Object.assign(new Image(), { src: url, alt: '' }) : Object.assign(document.createElement('span'), { textContent: isVideo(m.type) ? '🎬' : '📎' });
    thumb.className = 'thumb';
    if (thumb.tagName === 'IMG') thumb.onload = () => m.blob && URL.revokeObjectURL(url);
    li.append(thumb);
    li.insertAdjacentHTML('beforeend', `<span class="name">${escapeHtml(m.name)}</span><span class="size">${formatSize(m.size)}</span>`);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn small ghost';
    rm.textContent = '外す';
    rm.onclick = () => {
      formMedia = formMedia.filter((x) => x !== m);
      renderFormMedia();
    };
    li.append(rm);
    ul.append(li);
  }
}

/** 記録に添付された1件を表示。この端末に本体がなければ Drive から取得するボタンを出す */
async function showAttachment(item, a) {
  item.className = 'media-item';
  let url = urlCache.get(a.id);
  if (!url) {
    const f = await db.getFile(a.id);
    if (f) {
      url = URL.createObjectURL(f.blob);
      urlCache.set(a.id, url);
    }
  }
  item.innerHTML = '';
  if (!url) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.fetch = a.id;
    b.textContent = a.driveId ? `☁ ${a.name}（${formatSize(a.size)}）を取得` : `${a.name}（元の端末で同期すると取得できます）`;
    b.disabled = !a.driveId;
    b.onclick = () => fetchAttachment(item, a);
    item.append(b);
    return;
  }
  if (isImage(a.type)) {
    const img = Object.assign(new Image(), { src: url, alt: a.name, loading: 'lazy' });
    img.onclick = () => window.open(url, '_blank');
    item.append(img);
  } else if (isVideo(a.type)) {
    const v = Object.assign(document.createElement('video'), { src: url, controls: true, preload: 'metadata', playsInline: true });
    item.append(v);
  } else {
    item.append(Object.assign(document.createElement('a'), { href: url, download: a.name, textContent: a.name }));
  }
  item.insertAdjacentHTML('beforeend', `<div class="cap">${escapeHtml(a.name)} · ${formatSize(a.size)}</div>`);
}

async function fetchAttachment(item, a) {
  if (!navigator.onLine) return toast('オフラインのため取得できません');
  try {
    if (!drive.hasValidToken()) await drive.signIn(clientId());
    toast('取得中…');
    const blob = await drive.downloadMedia(a.driveId);
    await db.putFile({ id: a.id, name: a.name, type: a.type, size: blob.size, blob: new Blob([blob], { type: a.type }) });
    await showAttachment(item, a);
  } catch (e) {
    toast('取得できませんでした: ' + e.message);
  }
}

// ------------------------------------------------------------ 検索

function currentFilter() {
  return {
    q: S.q.value,
    from: S.from.value,
    to: S.to.value,
    type: S.type.value,
    tag: activeTag,
  };
}

function isValidUrl(s) {
  return /^https?:\/\//i.test(s);
}

function renderResults() {
  const f = currentFilter();
  const list = filterEntries(entries, f);
  const terms = parseQuery(f.q);
  const total = entries.filter((e) => !e.deleted).length;
  const filtered = f.q || f.from || f.to || f.type || f.tag;
  $('#result-count').textContent = total === 0 ? 'まだ記録がありません' : filtered ? `${list.length} 件ヒット（全 ${total} 件）` : `全 ${total} 件`;

  const ul = $('#results');
  ul.innerHTML = '';
  const LIMIT = 300;
  for (const e of list.slice(0, LIMIT)) {
    const li = document.createElement('li');
    const url = e.url
      ? `<div class="url">${isValidUrl(e.url) ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">${highlight(e.url, terms)}</a>` : highlight(e.url, terms)}</div>`
      : '';
    li.innerHTML = `
      <div class="meta">
        <span>${escapeHtml(e.date)}</span><span>${highlight(e.type || '', terms)}</span>
        ${e.dirty ? '<span class="dot" title="未同期">● 未同期</span>' : ''}
        <span class="tags">${(e.tags || []).map((t) => `<button type="button" class="chip" data-tag="${escapeHtml(t)}">#${highlight(t, terms)}</button>`).join('')}</span>
      </div>
      <div class="title">${highlight(e.title, terms)}</div>
      ${e.body ? `<div class="body clamp">${highlight(e.body, terms)}</div>` : ''}
      ${url}
      ${(e.attachments || []).length ? '<div class="media"></div>' : ''}
      <div class="ops">
        <button type="button" class="btn small ghost" data-op="edit">編集</button>
        <button type="button" class="btn small ghost" data-op="delete">削除</button>
      </div>`;
    li.querySelector('[data-op=edit]').onclick = () => startEdit(e);
    li.querySelector('[data-op=delete]').onclick = () => removeEntry(e);
    const box = li.querySelector('.media');
    if (box) for (const a of e.attachments) showAttachment(box.appendChild(document.createElement('div')), a);
    const body = li.querySelector('.body');
    if (body) body.onclick = () => body.classList.toggle('clamp');
    li.querySelectorAll('[data-tag]').forEach((b) => (b.onclick = () => setTag(b.dataset.tag)));
    ul.appendChild(li);
  }
  if (list.length > LIMIT) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = `ほか ${list.length - LIMIT} 件（条件を絞り込んでください）`;
    ul.appendChild(li);
  }
}

function renderTags() {
  const counts = new Map();
  for (const e of entries) if (!e.deleted) for (const t of e.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  if (activeTag && !counts.has(activeTag)) top.unshift([activeTag, 0]);
  $('#tag-cloud').innerHTML = top
    .map(([t, n]) => `<button type="button" class="chip${t === activeTag ? ' active' : ''}" data-tag="${escapeHtml(t)}">#${escapeHtml(t)} ${n}</button>`)
    .join('');
  $('#tag-cloud').querySelectorAll('[data-tag]').forEach((b) => (b.onclick = () => setTag(b.dataset.tag)));
}

function setTag(t) {
  activeTag = activeTag === t ? '' : t;
  renderTags();
  renderResults();
  $('#search-title').scrollIntoView({ behavior: 'smooth' });
}

searchForm.addEventListener('input', renderResults);
searchForm.querySelectorAll('[data-range]').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.range === 'clear') {
      searchForm.reset();
      activeTag = '';
      renderTags();
    } else {
      const d = new Date();
      d.setDate(d.getDate() - Number(b.dataset.range) + 1);
      S.from.value = todayString(d);
      S.to.value = '';
    }
    renderResults();
  });
});

/**
 * トークン切れの状態で画面をタップしたとき、自動で再接続を試みる。
 * ポップアップはユーザー操作の中でしか開けないため、最初のタップを利用する。
 * 失敗しても保存済みの接続情報（ファイルIDなど）は消さない。
 */
let reconnecting = false;
let lastReconnectAt = 0;
document.addEventListener(
  'click',
  async (ev) => {
    if (reconnecting || !navigator.onLine || !clientId() || !drive.wasConnected() || drive.hasValidToken()) return;
    if (ev.target.closest?.('#sync-btn, #banner-sync, #settings, #settings-btn, .no-reconnect, [data-fetch]')) return;
    if (Date.now() - lastReconnectAt < 30_000) return;
    reconnecting = true;
    lastReconnectAt = Date.now();
    try {
      await drive.signIn(clientId());
      await runSync();
    } catch (e) {
      console.warn('自動再接続をスキップ:', e.message);
    } finally {
      reconnecting = false;
      renderStatus();
    }
  },
  true,
);

// ------------------------------------------------------------ 設定

const dialog = $('#settings');

function openSettings() {
  $('#client-id').value = clientId();
  renderStatus();
  dialog.showModal();
}

$('#settings-btn').addEventListener('click', openSettings);
$('#sync-btn').addEventListener('click', manualSync);

$('#client-id').addEventListener('change', (ev) => {
  const v = ev.target.value.trim();
  if (v) localStorage.setItem(CLIENT_ID_KEY, v);
  else localStorage.removeItem(CLIENT_ID_KEY);
});

$('#connect-btn').addEventListener('click', async () => {
  const v = $('#client-id').value.trim();
  if (v) localStorage.setItem(CLIENT_ID_KEY, v);
  try {
    await drive.signIn(clientId(), { prompt: drive.wasConnected() ? '' : 'consent' });
    renderStatus();
    toast('Google ドライブに接続しました');
    await runSync({ quiet: false });
  } catch (e) {
    toast(e.message);
  }
});

$('#disconnect-btn').addEventListener('click', async () => {
  drive.signOut();
  await db.setMeta('driveFileId', null);
  renderStatus();
  toast('接続を解除しました（端末内のデータは残ります）');
});

$('#export-btn').addEventListener('click', () => {
  const data = buildRemoteFile(entries.map(toRemote));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `input-log-${todayString()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#import-file').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const incoming = parseRemoteFile(await file.text());
    const byId = new Map(entries.map((e) => [e.id, e]));
    const toPut = incoming
      .filter((r) => !byId.has(r.id) || (r.updatedAt || '') > (byId.get(r.id).updatedAt || ''))
      .map((r) => ({ ...r, dirty: true }));
    await db.putEntries(toPut);
    toast(`${toPut.length} 件を読み込みました`);
    await reload();
    scheduleSync();
  } catch (e) {
    toast('読み込みに失敗しました: ' + e.message);
  }
});

// ------------------------------------------------------------ 起動

window.addEventListener('online', () => {
  if (drive.wasConnected()) drive.preloadGis();
  renderStatus();
  autoSync();
});
window.addEventListener('offline', renderStatus);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') autoSync();
});
setInterval(autoSync, AUTO_SYNC_MS);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker 登録失敗', e));
}
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

(async () => {
  resetForm();
  if (navigator.onLine && drive.wasConnected()) drive.preloadGis();
  lastSyncAt = await db.getMeta('lastSync');
  await reload();
  autoSync();
})();
