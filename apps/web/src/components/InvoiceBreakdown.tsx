import { formatInvoiceAmount, type InvoiceView } from '@/lib/invoices';
import styles from './InvoiceBreakdown.module.css';

export function InvoiceBreakdown({ invoice }: { invoice: InvoiceView }) {
  const items = invoice.items ?? [{ description: invoice.description, amount: invoice.amount }];
  return (
    <table className={styles.table}>
      <caption>Payment breakdown</caption>
      <thead>
        <tr>
          <th scope="col">Description</th>
          <th scope="col">Amount ({invoice.amountCurrency === 'USD' ? 'USD' : invoice.symbol})</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, index) => (
          <tr key={index}>
            <td>{item.description}</td>
            <td>{formatInvoiceAmount(invoice, item.amount)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Total</th>
          <td>{formatInvoiceAmount(invoice)}</td>
        </tr>
      </tfoot>
    </table>
  );
}
