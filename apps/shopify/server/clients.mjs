import { TendrClient } from '@tendr/sdk';

export class ProviderError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function realProviders(config, store, fetchImpl = fetch) {
  async function json(url, options) {
    const response = await fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new ProviderError(`provider_http_${response.status}`);
    return response.json();
  }
  const tendr = (test) => {
    const mode = config.modes[test ? 'test' : 'live'];
    if (!mode.key) throw new ProviderError('mode_unconfigured');
    const headers = { Authorization: `Bearer ${mode.key}`, 'Content-Type': 'application/json' };
    return {
      create: (body, idempotencyKey) =>
        new TendrClient({
          baseUrl: config.tendrUrl,
          apiKey: mode.key,
          fetch: fetchImpl,
        }).checkoutSessions.create(body, { idempotencyKey }),
      read: (id) =>
        json(`${config.tendrUrl}/v1/checkout/sessions/${encodeURIComponent(id)}`, { headers }),
      refund: (body, key) =>
        json(`${config.tendrUrl}/v1/refunds`, {
          method: 'POST',
          headers: { ...headers, 'Idempotency-Key': key },
          body: JSON.stringify(body),
        }),
    };
  };
  async function graphql(query, variables, field) {
    const session = store.get('oauth');
    if (
      !session?.accessToken ||
      session.shop !== config.shop ||
      (session.expires && Date.parse(session.expires) <= Date.now())
    )
      throw new ProviderError('shopify_reauthorization_required');
    const result = await json(
      `https://${config.shop}/payments_apps/api/${config.apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': session.accessToken,
        },
        body: JSON.stringify({ query, variables }),
      },
    );
    const payload = result.data?.[field];
    if (
      result.errors?.length ||
      !payload ||
      !Array.isArray(payload.userErrors) ||
      payload.userErrors.length
    )
      throw new ProviderError('shopify_mutation_not_confirmed');
    return payload;
  }
  return {
    create: (op) => tendr(op.input.test).create(op.request, op.key),
    read: (op) => tendr(op.input.test).read(op.kind === 'payment' ? op.tendrId : op.sessionId),
    refund: (op) => tendr(op.input.test).refund(op.request, op.key),
    finish: async (op) => {
      const type = op.kind === 'payment' ? 'paymentSession' : 'refundSession';
      const field = `${type}${op.decision === 'resolve' ? 'Resolve' : 'Reject'}`;
      const reason =
        op.decision === 'reject'
          ? ', reason: {code: PROCESSING_ERROR, merchantMessage: "Tendr confirmed the operation cannot complete."}'
          : '';
      const nextAction =
        op.kind === 'payment'
          ? 'nextAction { action context { ... on PaymentSessionActionsRedirect { redirectUrl } } }'
          : '';
      const stateType = op.kind === 'payment' ? 'PaymentSession' : 'RefundSession';
      const state = `${stateType}State${op.decision === 'resolve' ? 'Resolved' : 'Rejected'}`;
      const result = await graphql(
        `mutation Finish($id: ID!) { ${field}(id: $id${reason}) { ${type} { id state { ... on ${state} { code } } ${nextAction} } userErrors { field message } } }`,
        { id: op.input.gid },
        field,
      );
      const session = result[type];
      if (
        session?.id !== op.input.gid ||
        session.state?.code !== (op.decision === 'resolve' ? 'RESOLVED' : 'REJECTED')
      )
        throw new ProviderError('shopify_state_not_confirmed');
      return { redirect: session.nextAction?.context?.redirectUrl || null };
    },
    configure: async (ready) => {
      const result = await graphql(
        'mutation Configure($ready: Boolean!, $handle: String) { paymentsAppConfigure(ready: $ready, externalHandle: $handle) { paymentsAppConfiguration { ready } userErrors { field message } } }',
        { ready, handle: config.externalHandle },
        'paymentsAppConfigure',
      );
      if (result.paymentsAppConfiguration?.ready !== ready)
        throw new ProviderError('shopify_configuration_not_confirmed');
    },
  };
}
