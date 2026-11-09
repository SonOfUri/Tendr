import { formatUnits } from '@/lib/assets';
import type { InvoiceView } from '@/lib/invoices';
import styles from './InvoiceBreakdown.module.css';

export function InvoiceBreakdown({ invoice }: { invoice: InvoiceView }) {
  const items = invoice.items ?? [{ description: invoice.description, amount: invoice.amount }];
  return (
    <table className={styles.table}>
      <caption>Payment breakdown</caption>
      <thead>
        <tr>
          <th scope="col">Description</th>
          <th scope="col">Amount ({invoice.symbol})</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, index) => (
          <tr key={index}>
            <td>{item.description}</td>
            <td>{formatUnits(item.amount, invoice.decimals)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Total</th>
          <td>
            {formatUnits(invoice.amount, invoice.decimals)} {invoice.symbol}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
