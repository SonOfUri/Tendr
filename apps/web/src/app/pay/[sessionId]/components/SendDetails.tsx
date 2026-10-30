'use client';

import { QrImage } from '@/components/QrImage';
import { CopyButton } from './CopyButton';
import { COPY_ADDRESS_FEE_NOTE } from './NetworkFee';

/**
 * Where and how much to send by hand: the QR of the deposit address, the address and the exact
 * amount (each with a copy button), and the "send only on <network>" warning.
 */
export function SendDetails({
  address,
  amount,
  symbol,
  network,
}: {
  address: string;
  /** The exact amount, as a decimal string. */
  amount: string;
  symbol: string;
  network: string;
}) {
  return (
    <div className="pay-send">
      <div className="pay-qr">
        <QrImage value={address} label={`QR code for the address ${address}`} size={168} />
      </div>
      <dl className="pay-kv">
        <div>
          <dt>Amount</dt>
          <dd>
            <span className="pay-strong">
              {amount} {symbol}
            </span>
            <CopyButton value={amount} label={`Copy the amount, ${amount} ${symbol}`} />
          </dd>
        </div>
        <div>
          <dt>To this address (for this order only)</dt>
          <dd>
            <span className="address">{address}</span>
            <CopyButton value={address} label="Copy the address" />
          </dd>
        </div>
      </dl>
      <p className="pay-warning" role="note">
        Send only on <strong>{network}</strong>, and send exactly{' '}
        <strong>
          {amount} {symbol}
        </strong>
        . Money sent on another network can be lost.
      </p>
      {/* Sending it yourself is never gasless, whoever sponsors the wallet path (spec §2.4). */}
      <p className="muted small">{COPY_ADDRESS_FEE_NOTE}</p>
    </div>
  );
}
