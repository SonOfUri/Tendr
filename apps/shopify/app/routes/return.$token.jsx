import { useLoaderData, useRevalidator } from 'react-router';
import { useEffect } from 'react';
export function loader({ context, params }) {
  const op = context.store.byToken(params.token);
  if (!op || op.kind !== 'payment') throw new Response('Not found', { status: 404 });
  return context.engine.view(op);
}
export default function PaymentReturn() {
  const op = useLoaderData();
  const revalidator = useRevalidator();
  useEffect(() => {
    if (op.done) return;
    const id = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(id);
  }, [op.done, revalidator]);
  return (
    <div className="checkout">
      <div className="eyebrow">PAYMENT STATUS</div>
      <h1>{op.state}</h1>
      <p>
        {op.amount} {op.currency}
      </p>
      <section className="card">
        <p>
          {op.done
            ? op.paid
              ? 'Tendr confirmed the payment and Shopify acknowledged it.'
              : 'This payment was not completed.'
            : 'We are waiting for the payment providers to confirm the result. Returning to this page does not mark your order as paid.'}
        </p>
        {op.returnUrl ? (
          <a className="button" href={op.returnUrl}>
            Return to store
          </a>
        ) : (
          <p>You can keep this page open while confirmation finishes.</p>
        )}
      </section>
    </div>
  );
}
