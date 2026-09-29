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

  // 1) 文字の記録を先に同期（写真・動画が重くても記録は確実に送る）
  const result = await syncEntries();
  // 2) 写真・動画のアップロード。ファイルIDを記録に書き戻したら、もう一度同期して Drive に反映
  const media = await syncMedia();
  if (media.uploaded) {
    const again = await syncEntries();
    result.pushed = result.pushed || again.pushed;
  }
  const at = new Date().toISOString();
  await db.setMeta('lastSync', at);
  return { ...result, media, at };
}

async function syncEntries() {
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

    return { pulled: toSaveLocal.length, pushed: remoteChanged };
  }
  throw new Error('他の端末と同時に更新されたため同期できませんでした。もう一度お試しください');
}

/** 未アップロードの写真・動画を送り、削除待ちのものを Drive から消す */
async function syncMedia() {
  const out = { uploaded: 0, failed: 0, deleted: 0, error: '' };

  const pending = (await db.getMeta('pendingDeletes')) || [];
  const remaining = [];
  for (const id of pending) {
    try {
      await drive.deleteMedia(id);
      out.deleted++;
    } catch (e) {
      if (e instanceof drive.AuthRequiredError) throw e;
      remaining.push(id);
    }
  }
  if (pending.length) await db.setMeta('pendingDeletes', remaining);

  const entries = (await db.getAllEntries()).filter((e) => !e.deleted && (e.attachments || []).some((a) => !a.driveId));
  for (const entry of entries) {
    const uploaded = new Map();
    for (const a of entry.attachments.filter((a) => !a.driveId)) {
      const f = await db.getFile(a.id);
      if (!f) continue; // 本体がこの端末にない（別端末で追加されたものが未アップロード）
      try {
        uploaded.set(a.id, await drive.uploadMedia(f.blob, `${a.id}_${a.name}`, a.type || 'application/octet-stream'));
        out.uploaded++;
      } catch (e) {
        if (e instanceof drive.AuthRequiredError) throw e;
        out.failed++;
        out.error = e.message;
      }
    }
    if (!uploaded.size) continue;
    // アップロード中に編集されていても消えないよう、最新の記録を読み直して書き戻す
    const fresh = await db.getEntry(entry.id);
    if (!fresh || fresh.deleted) {
      for (const id of uploaded.values()) await drive.deleteMedia(id).catch(() => {});
      continue;
    }
    fresh.attachments = (fresh.attachments || []).map((a) => (uploaded.has(a.id) ? { ...a, driveId: uploaded.get(a.id) } : a));
    fresh.updatedAt = new Date().toISOString();
    fresh.dirty = true;
    await db.putEntry(fresh);
  }
  return out;
}
