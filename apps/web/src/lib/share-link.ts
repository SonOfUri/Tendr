export type ShareResult = 'shared' | 'copied' | 'cancelled' | 'failed';

type ShareHost = {
  share?: (data: { title?: string; url?: string }) => Promise<void>;
  clipboard?: { writeText: (text: string) => Promise<void> };
};

/** Opens the device share sheet when the browser has one, otherwise copies the URL. */
export async function sharePaymentLink(
  url: string,
  title: string,
  host: ShareHost = typeof navigator === 'undefined' ? {} : navigator,
): Promise<ShareResult> {
  if (typeof host.share === 'function') {
    try {
      await host.share({ title, url });
      return 'shared';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    await host.clipboard?.writeText(url);
    if (!host.clipboard) return 'failed';
    return 'copied';
  } catch {
    return 'failed';
  }
}

/** True after mount on a phone (or desktop browser) that can open a share sheet. */
export function canNativeShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}
