// IndexedDB ラッパー（端末内の保存先。オフラインでもここに書き込む）

const DB_NAME = 'input-log';
const DB_VERSION = 2;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        // 写真・動画の本体（Blob）。記録側には id とメタ情報だけを持つ
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => (result = r.result);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const getAllEntries = () => tx('entries', 'readonly', (s) => s.getAll());
export const getEntry = (id) => tx('entries', 'readonly', (s) => s.get(id));
export const putEntry = (e) => tx('entries', 'readwrite', (s) => s.put(e));
export const putEntries = (list) =>
  tx('entries', 'readwrite', (s) => {
    for (const e of list) s.put(e);
  });

export const getMeta = (key) => tx('meta', 'readonly', (s) => s.get(key));
export const setMeta = (key, value) => tx('meta', 'readwrite', (s) => s.put(value, key));

export const getFile = (id) => tx('files', 'readonly', (s) => s.get(id));
export const putFile = (f) => tx('files', 'readwrite', (s) => s.put(f));
export const deleteFile = (id) => tx('files', 'readwrite', (s) => s.delete(id));
