import { useLoaderData } from 'react-router';
export function loader({ context, params }) {
  if (!context.config.simulated) throw new Response('Not found', { status: 404 });
  const op = context.store.byToken(params.token);
  if (!op?.done || op.kind !== 'payment') throw new Response('Not found', { status: 404 });
  return context.engine.view(op);
}
export default function Order() {
  const op = useLoaderData();
  return (
    <div className="checkout">
      <div className="eyebrow">SIMULATED SHOPIFY STORE</div>
      <h1>{op.paid ? 'Order paid.' : 'Payment rejected.'}</h1>
      <p>
        The simulated Shopify API acknowledged{' '}
        {op.paid ? 'paymentSessionResolve' : 'paymentSessionReject'}.
      </p>
      <section className="card">
        <p>
          {op.amount} {op.currency}
        </p>
        <p>Next, request a refund from the connector to test the wallet approval step.</p>
        <a className="button" href="/app">
          View payments and refunds
        </a>
      </section>
    </div>
  );
}
