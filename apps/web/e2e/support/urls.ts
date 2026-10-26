// Where the end-to-end servers listen (playwright.config.ts starts them; the specs call them).
// Own ports, so a running `npm run dev` (dev database, real NEAR settings) is never reused.
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
export const API_PORT = Number(process.env.E2E_API_PORT ?? 4100);
export const STORE_PORT = Number(process.env.E2E_STORE_PORT ?? 3200);

export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const API_URL = `http://localhost:${API_PORT}`;
/** The fixture store, registered as a checkout domain by the checkout specs. */
export const STORE_URL = `http://localhost:${STORE_PORT}`;
/** The same fixture server on another origin, never registered. */
export const OTHER_STORE_URL = `http://127.0.0.1:${STORE_PORT}`;

/** Any well-formed code hash: the in-memory NEAR client never deploys anything. The API server
 * and the checkout seed (which writes merchant-account rows) must agree on it. */
export const E2E_CODE_HASH = '11111111111111111111111111111111';
