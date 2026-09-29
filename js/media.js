// 写真・動画まわりのブラウザ用ヘルパー

export const MAX_FILE_BYTES = 500 * 1024 * 1024; // 1ファイルの上限
const MAX_IMAGE_EDGE = 2048; // 写真は長辺をこの大きさまで縮小して保存（容量とアップロード時間の節約）

export const isImage = (type) => /^image\//.test(type || '');
export const isVideo = (type) => /^video\//.test(type || '');

export function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 写真を縮小した JPEG にする。GIF・SVG や、変換に失敗した場合・小さくならない場合は元のまま */
export async function prepareImage(file) {
  if (!isImage(file.type) || /gif|svg/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // 透過 PNG の背景
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
    if (!blob || (blob.size >= file.size && scale === 1)) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
