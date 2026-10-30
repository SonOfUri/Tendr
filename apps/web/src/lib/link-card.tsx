// The 1200×630 preview card (rendered by `next/og`): logo (or the merchant's initial), merchant
// name, link title and price. Only inline styles with flex layout, which is all Satori supports.
import type { PublicPaymentLinkView } from '@tendr/contracts';
import { themeDisplayName } from './checkout/brand';
import { linkCardPrice } from './link-preview';

export const CARD_SIZE = { width: 1200, height: 630 } as const;

function dataUrl(logo: ArrayBuffer): string {
  const bytes = new Uint8Array(logo);
  const svg = bytes[0] === 0x3c; // '<'
  return `data:${svg ? 'image/svg+xml' : 'image/png'};base64,${Buffer.from(bytes).toString('base64')}`;
}

export function LinkCard({
  view,
  logo,
  test,
}: {
  view: PublicPaymentLinkView;
  logo: ArrayBuffer | null;
  test: boolean;
}) {
  const price = linkCardPrice(view);
  const name = themeDisplayName(view.theme);
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? '?';
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 72,
        background: '#080D1B',
        color: '#FFFFFF',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={dataUrl(logo)}
            width={96}
            height={96}
            style={{ borderRadius: 48, objectFit: 'cover' }}
            alt=""
          />
        ) : (
          <div
            style={{
              width: 96,
              height: 96,
              borderRadius: 48,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#2D5BFF',
              fontSize: 52,
              fontWeight: 700,
            }}
          >
            {initial}
          </div>
        )}
        <div style={{ display: 'flex', marginLeft: 28, fontSize: 44, color: '#C9D1E8' }}>{name}</div>
        {test ? (
          <div
            style={{
              display: 'flex',
              marginLeft: 'auto',
              padding: '8px 24px',
              borderRadius: 999,
              border: '2px solid #F5B942',
              color: '#F5B942',
              fontSize: 32,
            }}
          >
            Test
          </div>
        ) : null}
      </div>
      <div
        style={{
          display: 'flex',
          fontSize: 76,
          fontWeight: 700,
          lineHeight: 1.25,
          maxHeight: 320,
          overflow: 'hidden',
        }}
      >
        {view.title}
      </div>
      <div style={{ display: 'flex', fontSize: 56, color: '#7FA0FF' }}>{price ?? ' '}</div>
    </div>
  );
}
