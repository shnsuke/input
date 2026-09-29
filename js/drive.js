// Google Drive 連携（Google Identity Services でトークン取得 → Drive REST API）
//
// スコープは drive.file（このアプリが作ったファイルだけにアクセスできる最小権限）。
// マイドライブの「InputLog」フォルダに input-log.json を1つ置き、全エントリを保存する。

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'InputLog';
const FILE_NAME = 'input-log.json';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_KEY = 'inputlog.token';

let gisPromise;
let tokenClient;
let tokenClientId;

export function preloadGis() {
  return loadGis().catch(() => {});
}

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        gisPromise = null;
        s.remove();
        reject(new Error('Google のログイン用スクリプトを読み込めませんでした（オフライン？）'));
      };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

function readToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (t && t.expiresAt - 60_000 > Date.now()) return t;
  } catch {}
  return null;
}

export function hasValidToken() {
  return !!readToken();
}

export function wasConnected() {
  return localStorage.getItem(TOKEN_KEY) !== null;
}

/** ユーザー操作（クリック）から呼ぶこと。ポップアップで Google アカウントの許可を求める */
export async function signIn(clientId, { prompt = '' } = {}) {
  if (!clientId) throw new Error('設定で Google OAuth クライアントIDを入力してください');
  await loadGis();
  if (!tokenClient || tokenClientId !== clientId) {
    tokenClientId = clientId;
    tokenClient = google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: SCOPE, callback: () => {} });
  }
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error('Google 認証エラー: ' + resp.error));
      const t = { accessToken: resp.access_token, expiresAt: Date.now() + Number(resp.expires_in || 3600) * 1000 };
      localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
      resolve(t);
    };
    tokenClient.error_callback = (err) => reject(new Error('Google 認証を完了できませんでした: ' + (err?.type || err)));
    tokenClient.requestAccessToken({ prompt });
  });
}

export function signOut() {
  const t = readToken();
  localStorage.removeItem(TOKEN_KEY);
  if (t && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t.accessToken, () => {});
}

export class AuthRequiredError extends Error {}

async function api(url, opts = {}) {
  const t = readToken();
  if (!t) throw new AuthRequiredError('Google への再接続が必要です');
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t.accessToken } });
  if (res.status === 401) {
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ ...t, expiresAt: 0 }));
    throw new AuthRequiredError('Google への再接続が必要です');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Drive API エラー (${res.status}) ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

const q = (s) => encodeURIComponent(s);

async function findOne(query) {
  const res = await api(`${API}/files?q=${q(query)}&spaces=drive&fields=files(id,name,version)&pageSize=10&orderBy=modifiedTime desc`);
  const { files } = await res.json();
  return files[0] || null;
}

async function ensureFolder() {
  const found = await findOne(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  if (found) return found.id;
  const res = await api(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  return (await res.json()).id;
}

/** 同期ファイルを探す（なければ null） */
export async function findDataFile(knownId) {
  if (knownId) {
    try {
      const res = await api(`${API}/files/${knownId}?fields=id,version,trashed`);
      const f = await res.json();
      if (!f.trashed) return f;
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e;
      if (e.status !== 404) throw e;
    }
  }
  return findOne(`name='${FILE_NAME}' and trashed=false`);
}

export async function getVersion(fileId) {
  const res = await api(`${API}/files/${fileId}?fields=version`);
  return (await res.json()).version;
}

export async function download(fileId) {
  const res = await api(`${API}/files/${fileId}?alt=media`);
  return res.text();
}

export async function createDataFile(content) {
  const folderId = await ensureFolder();
  const boundary = 'inputlog' + Math.random().toString(36).slice(2);
  const meta = { name: FILE_NAME, mimeType: 'application/json', parents: [folderId] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id,version`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return res.json();
}

export async function updateDataFile(fileId, content) {
  const res = await api(`${UPLOAD}/files/${fileId}?uploadType=media&fields=id,version`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: content,
  });
  return res.json();
}
