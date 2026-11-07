import { redirect } from 'react-router';
import { Form, useLoaderData } from 'react-router';
function get(context, token) {
  if (!context.config.simulated) throw new Response('Not found', { status: 404 });
  const op = context.store.byToken(token);
  if (!op || op.kind !== 'payment') throw new Response('Not found', { status: 404 });
  return op;
}
export function loader({ context, params }) {
  return context.engine.view(get(context, params.token));
}
export async function action({ request, context, params }) {
  context.checkOrigin(request);
  const op = get(context, params.token);
  const data = await request.formData();
  if (!['pay', 'expire'].includes(data.get('action')))
    throw new Response('Invalid action', { status: 400 });
  await context.providers.transition(context.engine, op, data.get('action'));
  return redirect(`/return/${op.token}`);
}
export default function Checkout() {
  const op = useLoaderData();
  return (
    <div className="checkout">
      <div className="eyebrow">SIMULATED TENDR CHECKOUT</div>
      <h1>
        {op.amount} {op.currency}
      </h1>
      <p>No wallet or real funds are involved.</p>
      <section className="card">
        <h2>Complete the test payment</h2>
        <p>
          This updates the fixture in the simulated Tendr API and signs a webhook. The connector
          reads the API before confirming the order.
        </p>
        <Form method="post" className="actions">
          <button name="action" value="pay" disabled={op.done}>
            Simulate payment
          </button>
          <button name="action" value="expire" className="secondary" disabled={op.done}>
            Simulate expiry
          </button>
        </Form>
      </section>
      <a href="/app">Back to connector</a>
    </div>
  );
}
