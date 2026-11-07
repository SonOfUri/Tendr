import { Form, useLoaderData, useNavigation, useRevalidator } from 'react-router';
import { useEffect } from 'react';
export async function loader({ request, context }) {
  await context.requireAdmin(request);
  return {
    simulated: context.config.simulated,
    shop: context.config.shop,
    ready: Boolean(context.store.get('ready')),
    testOnly: context.config.testOnly,
    live: Boolean(context.config.modes.live.key),
    operations: context.store
      .list({ limit: 100 })
      .reverse()
      .map((op) => context.engine.view(op)),
  };
}
export const action = ({ request, context }) => context.action(request);
export default function Dashboard() {
  const { simulated, shop, ready, live, testOnly, operations } = useLoaderData();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') revalidator.revalidate();
    }, 5000);
    return () => clearInterval(id);
  }, [revalidator]);
  return (
    <>
      <div className="eyebrow">
        {simulated ? 'LOCAL SIMULATOR · NO REAL FUNDS' : 'SINGLE-STORE CONNECTOR'}
      </div>
      <h1>{simulated ? 'Try the Shopify payment flow.' : 'Your Shopify payments.'}</h1>
      <p className="intro">
        {simulated
          ? 'Create an order, pay through a simulated Tendr checkout, and approve a refund. Both providers are simulated; this does not create a Shopify store.'
          : shop}
      </p>
      {simulated ? (
        <section className="card">
          <h2>New test order</h2>
          <Form method="post" className="inline">
            <input type="hidden" name="action" value="create" />
            <label>
              Amount in USD
              <input
                name="amount"
                inputMode="decimal"
                defaultValue="1.00"
                required
                pattern="[0-9]+([.][0-9]{1,6})?"
              />
            </label>
            <button disabled={navigation.state !== 'idle'}>Open test checkout</button>
          </Form>
        </section>
      ) : (
        <section className="card">
          <h2>Gateway {ready ? 'enabled' : 'not enabled'}</h2>
          <p>
            {testOnly ? 'Test-only mode is enforced. ' : ''}Test keys are configured. Live keys are{' '}
            {live ? 'configured' : 'missing'}. Confirm the account and payout in Tendr before
            enabling payments.
          </p>
          <Form method="post">
            <input type="hidden" name="action" value="configure" />
            <input type="hidden" name="ready" value={ready ? 'false' : 'true'} />
            <button disabled={!ready && !testOnly && !live}>
              {ready ? 'Disable gateway' : 'Enable gateway in Shopify'}
            </button>
          </Form>
        </section>
      )}
      <section className="card">
        <h2>Payments and refunds</h2>
        <p>
          Refunds wait for the wallet owner’s approval in Tendr. Only a confirmed send completes the
          Shopify refund.
        </p>
        {operations.length === 0 ? (
          <p className="empty">Your first order will appear here.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {operations.map((op) => (
                  <tr key={op.token}>
                    <td>
                      <strong>{op.kind === 'payment' ? 'Payment' : 'Refund'}</strong>
                      <small>
                        {op.mode} · {op.id.slice(0, 8)}
                      </small>
                    </td>
                    <td>
                      {op.amount} {op.currency}
                    </td>
                    <td>
                      <span className={op.done ? 'badge done' : 'badge'}>{op.state}</span>
                      {op.attention && <small>Provider check pending</small>}
                    </td>
                    <td>
                      {simulated && op.kind === 'payment' && !op.done && (
                        <a href={`/checkout/${op.token}`}>Open checkout</a>
                      )}
                      {simulated && op.kind === 'payment' && op.paid && (
                        <Form method="post" className="refund-form">
                          <input type="hidden" name="action" value="refund" />
                          <input type="hidden" name="token" value={op.token} />
                          <label className="sr-only" htmlFor={op.token}>
                            Refund amount
                          </label>
                          <input
                            id={op.token}
                            name="amount"
                            defaultValue={op.amount}
                            inputMode="decimal"
                            required
                          />
                          <button className="secondary">Request refund</button>
                        </Form>
                      )}
                      {simulated && op.kind === 'refund' && !op.done && (
                        <Form method="post">
                          <input type="hidden" name="action" value="approve-refund" />
                          <input type="hidden" name="token" value={op.token} />
                          <button className="secondary">Simulate wallet approval</button>
                        </Form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <footer>
        {simulated
          ? 'The simulator runs entirely in this container. Shopify installation requires a dev store and Payments Partner approval.'
          : 'This pilot serves one configured store. Keep its database and encryption key backed up together.'}
      </footer>
    </>
  );
}
