/**
 * Saving exported sheets.
 *
 * Web: normal browser download.
 * Android (Capacitor): write to the app cache and open the system share sheet,
 * because WebView does not reliably handle `<a download>` / blob downloads.
 */
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { isNativeApp } from './native';

function sanitiseFileName(fileName: string): string {
  return fileName.replace(/[\\/:*?"<>|]/g, '-').trim() || 'piano-sheet';
}

function downloadInBrowser(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    for (let i = 0; i < chunk.length; i += 1) binary += String.fromCharCode(chunk[i]);
  }
  return btoa(binary);
}

export interface SaveResult {
  mode: 'downloaded' | 'shared';
  fileName: string;
}

/** Saves a Blob, using the Android share sheet inside the native app. */
export async function saveBlob(blob: Blob, fileName: string): Promise<SaveResult> {
  const safeName = sanitiseFileName(fileName);
  if (!isNativeApp()) {
    downloadInBrowser(blob, safeName);
    return { mode: 'downloaded', fileName: safeName };
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const written = await Filesystem.writeFile({
    path: `exports/${safeName}`,
    data: bytesToBase64(bytes),
    directory: Directory.Cache,
    recursive: true,
  });
  await Share.share({
    title: safeName,
    text: 'Piano Studio export',
    files: [written.uri],
    dialogTitle: 'Save or share your sheet',
  });
  return { mode: 'shared', fileName: safeName };
}
