export type ShareResult = 'shared' | 'copied' | 'cancelled' | 'failed';

type ShareHost = {
  share?: (data: { title?: string; url?: string; text?: string }) => Promise<void>;
  clipboard?: { writeText: (text: string) => Promise<void> };
};

/** Clipboard write with a legacy textarea fallback when the async API is missing or blocked. */
export async function copyToClipboard(
  text: string,
  host: ShareHost = typeof navigator === 'undefined' ? {} : navigator,
): Promise<boolean> {
  if (host.clipboard?.writeText) {
    try {
      await host.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand — some browsers block clipboard without a focused doc.
    }
  }
  if (typeof document === 'undefined') return false;
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.top = '0';
    el.style.left = '-9999px';
    document.body.appendChild(el);
    el.focus();
    el.select();
    el.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

function prefersNativeShare(): boolean {
  const media = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia : null;
  if (!media) return false;
  // Desktop Chromium ships navigator.share; still prefer clipboard for "copy URL".
  return media.call(globalThis, '(pointer: coarse)').matches;
}

/**
 * On phones: open the share sheet when available.
 * On desktop: always copy the URL (share sheets feel broken / like a no-op).
 */
export async function sharePaymentLink(
  url: string,
  title: string,
  host: ShareHost = typeof navigator === 'undefined' ? {} : navigator,
): Promise<ShareResult> {
  if (typeof host.share === 'function' && prefersNativeShare()) {
    try {
      await host.share({ title, url, text: url });
      return 'shared';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      // Share failed — fall through to clipboard.
    }
  }
  return (await copyToClipboard(url, host)) ? 'copied' : 'failed';
}

/** True after mount on a touch device that can open a share sheet. */
export function canNativeShare(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    prefersNativeShare()
  );
}
