// Transactional HTML shell for Tendr emails. Plain text remains authoritative for clients that
// strip HTML; this layer escapes every untrusted string and never auto-follows action URLs.

const escape = (v: string) =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"']+/);
  return m?.[0] ?? null;
}

function bannerUrl(): string {
  const raw = process.env.WEB_URL?.trim() || 'https://app.usetendr.tech';
  return `${raw.replace(/\/$/, '')}/banner-gif.webp`;
}

/**
 * Builds a table-based HTML body from a subject + plain-text body. The first http(s) URL in the
 * text becomes the primary CTA when present.
 */
export function renderMailHtml(opts: {
  subject: string;
  text: string;
  preheader?: string;
}): string {
  const subject = escape(opts.subject);
  const preheader = escape(opts.preheader ?? opts.text.split('\n').find((l) => l.trim()) ?? '');
  const cta = firstUrl(opts.text);
  const lines = opts.text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''));
  const paragraphs = lines
    .map((line) => {
      if (!line) return '<tr><td style="height:12px;line-height:12px;font-size:0;">&nbsp;</td></tr>';
      if (cta && line === cta) return '';
      if (/^https?:\/\//.test(line)) {
        const url = escape(line);
        return `<tr><td style="padding:4px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#5c6270;word-break:break-all;"><a href="${url}" style="color:#161616;">${url}</a></td></tr>`;
      }
      return `<tr><td style="padding:4px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#161616;">${escape(line)}</td></tr>`;
    })
    .filter(Boolean)
    .join('');

  const ctaBlock = cta
    ? `<tr><td style="padding:20px 0 8px;">
        <a href="${escape(cta)}" style="display:inline-block;background:#161616;color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;padding:12px 18px;border-radius:10px;">Continue</a>
      </td></tr>
      <tr><td style="padding:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#5c6270;word-break:break-all;">
        Or copy this link:<br/><a href="${escape(cta)}" style="color:#161616;">${escape(cta)}</a>
      </td></tr>`
    : '';

  const banner = escape(bannerUrl());

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e5e5;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="padding:0;background:#0a0a0a;">
              <img src="${banner}" alt="Tendr" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0;"/>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 28px 8px;font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:1.25;font-weight:700;color:#0a0a0a;letter-spacing:-0.02em;">
              ${subject}
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${paragraphs}
                ${ctaBlock}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px 28px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#8a8f98;border-top:1px solid #ececec;">
              Tendr · Payments that settle where you bank crypto.<br/>
              This email does not auto-verify any action. Links expire and work once when noted in the message.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
