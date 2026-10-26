import { describe, expect, it } from 'vitest';
import { HttpOneClick, type FetchLike } from './http.js';
import { OneClickError, type QuoteRequest } from './types.js';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(respond: (r: Recorded) => { status: number; body: unknown }) {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    const r: Recorded = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(r);
    const { status, body } = respond(r);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

const req: QuoteRequest = {
  dry: false,
  swapType: 'EXACT_OUTPUT',
  slippageTolerance: 100,
  originAsset: 'nep141:eth.omft.near',
  depositType: 'ORIGIN_CHAIN',
  destinationAsset: 'nep141:usdc.near',
  amount: '25000000',
  refundTo: '0x1111111111111111111111111111111111111111',
  refundType: 'ORIGIN_CHAIN',
  recipient: 'shop.tendr.near',
  recipientType: 'INTENTS',
  deadline: '2026-10-25T12:12:00.000Z',
  appFees: [{ recipient: 'fees.tendr.near', fee: 50 }],
};

const quoteBody = {
  quote: {
    depositAddress: '0xdeposit',
    amountIn: '10000000000000000',
    amountInUsd: '25.20',
    amountOut: '25000000',
    amountOutUsd: '25.00',
    minAmountIn: '10000000000000000',
    deadline: '2026-10-25T12:12:00.000Z',
    timeWhenInactive: '2026-10-25T12:12:00.000Z',
    amountInFormatted: '0.01',
  },
  quoteRequest: {},
  signature: 'ed25519:x',
  timestamp: '2026-10-25T12:00:00.000Z',
  correlationId: 'corr-1',
};

describe('HttpOneClick', () => {
  it('posts the quote body verbatim to /v0/quote with the X-API-Key header', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 201, body: quoteBody }));
    const client = new HttpOneClick({ baseUrl: 'https://1click.test/', apiKey: 'jwt-1', fetch });
    const res = await client.quote(req);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://1click.test/v0/quote');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['X-API-Key']).toBe('jwt-1');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.headers.Authorization).toBeUndefined();
    expect(calls[0]!.body).toEqual(req);
    expect(res).toEqual({
      quote: {
        depositAddress: '0xdeposit',
        amountIn: '10000000000000000',
        amountInUsd: '25.20',
        amountOut: '25000000',
        amountOutUsd: '25.00',
        minAmountIn: '10000000000000000',
        deadline: '2026-10-25T12:12:00.000Z',
        timeWhenInactive: '2026-10-25T12:12:00.000Z',
      },
      correlationId: 'corr-1',
    });
  });

  it('sends no auth header when no API key is configured', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: [] }));
    await new HttpOneClick({ baseUrl: 'https://1click.test', fetch }).tokens();
    expect(calls[0]!.headers['X-API-Key']).toBeUndefined();
  });

  it('maps a non-2xx response to a OneClickError with status and code', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 400,
      body: { message: 'amount is too low', code: 'AMOUNT_TOO_LOW' },
    }));
    const client = new HttpOneClick({ baseUrl: 'https://1click.test', apiKey: 'k', fetch });
    const err = await client.quote(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OneClickError);
    expect(err).toMatchObject({
      status: 400,
      code: 'AMOUNT_TOO_LOW',
      message: 'amount is too low',
    });
  });

  it('falls back to HTTP_<status> when the error body has no code', async () => {
    const fetch: FetchLike = async () => new Response('upstream down', { status: 503 });
    const err = await new HttpOneClick({ baseUrl: 'https://1click.test', fetch })
      .status('0xabc')
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'OneClickError', status: 503, code: 'HTTP_503' });
  });

  it('times out a request that never answers', async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const client = new HttpOneClick({ baseUrl: 'https://1click.test', fetch, timeoutMs: 20 });
    const err = await client.tokens().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OneClickError);
    expect(err).toMatchObject({ status: null, code: 'TIMEOUT' });
  });

  it('maps a network failure to code NETWORK', async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const err = await new HttpOneClick({ baseUrl: 'https://1click.test', fetch })
      .tokens()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: null, code: 'NETWORK' });
  });

  it('reads status by deposit address and normalizes tx hashes', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: {
        correlationId: 'c',
        quoteResponse: {},
        status: 'SUCCESS',
        updatedAt: '2026-10-25T12:05:00.000Z',
        swapDetails: {
          intentHashes: [],
          nearTxHashes: [],
          amountIn: '10',
          amountOut: '25000000',
          refundedAmount: '0',
          originChainTxHashes: [{ hash: '0xorigin', explorerUrl: 'https://x/0xorigin' }],
          destinationChainTxHashes: ['NearDestHash'],
        },
      },
    }));
    const res = await new HttpOneClick({ baseUrl: 'https://1click.test', fetch }).status(
      '0xdep osit',
    );
    expect(calls[0]!.url).toBe('https://1click.test/v0/status?depositAddress=0xdep+osit');
    expect(res).toEqual({
      status: 'SUCCESS',
      swapDetails: {
        originChainTxHashes: [{ hash: '0xorigin', explorerUrl: 'https://x/0xorigin' }],
        destinationChainTxHashes: [{ hash: 'NearDestHash' }],
        amountIn: '10',
        amountOut: '25000000',
        refundedAmount: '0',
      },
    });
  });

  it('rejects an unknown status value', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: { status: 'WEIRD', swapDetails: {} },
    }));
    const err = await new HttpOneClick({ baseUrl: 'https://1click.test', fetch })
      .status('0x1')
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('T3: an untrusted status value is truncated in the error message', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: { status: 'W'.repeat(10_000), swapDetails: {} },
    }));
    const err = (await new HttpOneClick({ baseUrl: 'https://1click.test', fetch })
      .status('0x1')
      .catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ code: 'BAD_RESPONSE' });
    expect(err.message.length).toBeLessThan(300);
  });

  it('T3: an untrusted error message and code are truncated', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 409,
      body: { message: 'M'.repeat(10_000), code: 'C'.repeat(10_000) },
    }));
    const err = (await new HttpOneClick({ baseUrl: 'https://1click.test', fetch })
      .status('0x1')
      .catch((e: unknown) => e)) as OneClickError;
    expect(err.message.length).toBeLessThanOrEqual(200);
    expect(err.code.length).toBeLessThanOrEqual(200);
  });

  it('submits a deposit tx hash', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { status: 'PROCESSING' } }));
    await new HttpOneClick({ baseUrl: 'https://1click.test', apiKey: 'k', fetch }).submitDeposit(
      '0xtx',
      '0xdeposit',
    );
    expect(calls[0]).toMatchObject({
      url: 'https://1click.test/v0/deposit/submit',
      method: 'POST',
      body: { txHash: '0xtx', depositAddress: '0xdeposit' },
    });
  });

  it('maps the token list (price → priceUsd)', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: [
        {
          assetId: 'nep141:usdc.near',
          decimals: 6,
          blockchain: 'near',
          symbol: 'USDC',
          price: 1,
          priceUpdatedAt: '2026-10-25T12:00:00Z',
          contractAddress: 'usdc.near',
        },
        { assetId: 'nep141:x', decimals: 18, blockchain: 'eth', symbol: 'X' },
      ],
    }));
    const tokens = await new HttpOneClick({ baseUrl: 'https://1click.test', fetch }).tokens();
    expect(calls[0]!.url).toBe('https://1click.test/v0/tokens');
    expect(tokens).toEqual([
      {
        assetId: 'nep141:usdc.near',
        decimals: 6,
        blockchain: 'near',
        symbol: 'USDC',
        priceUsd: '1',
      },
      { assetId: 'nep141:x', decimals: 18, blockchain: 'eth', symbol: 'X' },
    ]);
  });
});
