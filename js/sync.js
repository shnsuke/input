// 端末内データ ⇔ Google Drive の同期処理
import * as db from './db.js';
import * as drive from './drive.js';
import { mergeEntries, buildRemoteFile, parseRemoteFile } from './core.js';

let running = null;

export function isSyncing() {
  return !!running;
}

/** 同期を1回実行する。実行中に呼ばれたら同じ Promise を返す */
export function syncNow() {
  if (!running) running = doSync().finally(() => (running = null));
  return running;
}

async function doSync() {
  if (!navigator.onLine) throw new Error('オフラインです');
  if (!drive.hasValidToken()) throw new drive.AuthRequiredError('Google への再接続が必要です');

  let file = await drive.findDataFile(await db.getMeta('driveFileId'));

  // 他の端末と同時に書き込んだ場合に備え、アップロード直前に Drive 側の版を確認してやり直す
  for (let attempt = 0; attempt < 3; attempt++) {
    const remote = file ? parseRemoteFile(await drive.download(file.id)) : [];
    const local = await db.getAllEntries();
    const snapshot = new Map(local.map((e) => [e.id, e.updatedAt]));
    const { merged, toSaveLocal, remoteChanged } = mergeEntries(local, remote);

    if (remoteChanged || !file) {
      const content = JSON.stringify(buildRemoteFile(merged));
      if (file) {
        const v = await drive.getVersion(file.id);
        if (v !== file.version) {
          file = { ...file, version: v };
          continue;
        }
        file = await drive.updateDataFile(file.id, content);
      } else {
        file = await drive.createDataFile(content);
      }
    }
    await db.setMeta('driveFileId', file.id);

    // Drive 側から取り込み & 送信済みエントリの「未同期」印を外す。
    // 同期中に編集されたもの（updatedAt が変わったもの）は次回に回す。
    const current = new Map((await db.getAllEntries()).map((e) => [e.id, e]));
    const updates = [];
    for (const r of toSaveLocal) {
      const c = current.get(r.id);
      if (!c || (c.updatedAt || '') <= (r.updatedAt || '')) {
        updates.push({ ...r, dirty: false });
        current.delete(r.id);
      }
    }
    for (const c of current.values()) {
      if (c.dirty && c.updatedAt === snapshot.get(c.id)) updates.push({ ...c, dirty: false });
    }
    if (updates.length) await db.putEntries(updates);

    const now = new Date().toISOString();
    await db.setMeta('lastSync', now);
    return { pulled: toSaveLocal.length, pushed: remoteChanged, at: now };
  }
  throw new Error('他の端末と同時に更新されたため同期できませんでした。もう一度お試しください');
}
