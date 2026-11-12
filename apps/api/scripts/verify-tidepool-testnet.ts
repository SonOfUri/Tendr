// Real testnet transfers, isolated from Tendr's database, credentials and live wallets.
// Default: print public funding addresses/balances. --run: resume one payment + withdrawal.
// A software P256 fixture exercises the verifier encoding; it is NOT a browser passkey test.
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { p256 } from '@noble/curves/p256';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { Interface, JsonRpcProvider, Wallet } from 'ethers';
import {
  nativeAccountId,
  nativePublicKey,
  payloadChallenge,
  signedIntent,
  type NativeSignedIntent,
} from '../src/accounts/native-signing.js';
import { matchingCredits, type TxReceipt } from '../src/near/events.js';
import {
  TIDEPOOL_TOKENS as tokens,
  TIDEPOOL_VERIFIER,
  TidepoolOneClick,
  tidepoolTransferPayload,
  tidepoolNearSettlementHashes,
} from '../src/checkout/oneclick/tidepool.js';
import type { QuoteResponse, StatusResponse } from '../src/checkout/oneclick/types.js';

const dir = fileURLToPath(new URL('../../../.keyvault/', import.meta.url));
const statePath = `${dir}tidepool-pilot.json`;
const nearUrl = 'https://rpc.testnet.fastnear.com';
const sol = new Connection('https://api.devnet.solana.com', 'finalized');
const base = new JsonRpcProvider('https://sepolia.base.org');
const tidepool = new TidepoolOneClick();
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (value: object) => console.log(JSON.stringify(value));
const erc20 = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

interface Leg {
  quote: QuoteResponse;
  status?: StatusResponse;
  verified?: { hashes: string[]; amount: string; verifiedAt: string };
}
interface State {
  version: number;
  network: string;
  createdAt: string;
  customerSolana: { address: string; secretKey: string };
  withdrawalBase: { address: string; privateKey: string };
  merchant: { publicKeyJwk: { x: string; y: string }; privateKeyPem: string };
  payment?: Leg & {
    transaction?: { raw: string; signature: string; lastValidBlockHeight: number };
    notified?: boolean;
  };
  withdrawal?: Leg & {
    signed?: NativeSignedIntent;
    intentHash?: string;
    submissionAttemptedAt?: string;
  };
}

async function save(state: State) {
  await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(`${statePath}.tmp`, statePath);
}

async function load(): Promise<State> {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as State;
    if (state.network !== 'testnet' || state.version !== 1)
      throw new Error('Unexpected pilot state');
    await chmod(statePath, 0o600);
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const customer = Keypair.generate();
    const destination = Wallet.createRandom();
    const merchant = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const state: State = {
      version: 1,
      network: 'testnet',
      createdAt: new Date().toISOString(),
      customerSolana: {
        address: customer.publicKey.toBase58(),
        secretKey: Buffer.from(customer.secretKey).toString('base64'),
      },
      withdrawalBase: { address: destination.address, privateKey: destination.privateKey },
      merchant: {
        publicKeyJwk: merchant.publicKey.export({ format: 'jwk' }) as { x: string; y: string },
        privateKeyPem: merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      },
    };
    await save(state);
    return state;
  }
}

async function nearRpc<T>(method: string, params: object): Promise<T> {
  const response = await fetch(nearUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'tendr-tidepool-pilot', method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as { result: T; error?: unknown };
  if (!response.ok || body.error) throw new Error(`NEAR testnet ${method} failed`);
  return body.result;
}

async function view<T>(method: string, args: object): Promise<T> {
  const result = await nearRpc<{ result?: number[]; error?: string }>('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: TIDEPOOL_VERIFIER,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  if (!result.result || result.error) throw new Error(`Verifier ${method} failed`);
  return JSON.parse(Buffer.from(result.result).toString()) as T;
}

async function guardNetworks() {
  const [near, genesis, evm] = await Promise.all([
    nearRpc<{ chain_id: string }>('status', {}),
    sol.getGenesisHash(),
    base.getNetwork(),
  ]);
  if (
    near.chain_id !== 'testnet' ||
    genesis !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' ||
    evm.chainId !== 84532n
  ) {
    throw new Error('Refusing to run outside NEAR testnet, Solana devnet and Base Sepolia');
  }
  await tidepool.tokens();
}

async function waitForSwap(leg: Leg, state: State): Promise<StatusResponse> {
  const address = leg.quote.quote.depositAddress!;
  // Bounded wait. Re-running resumes the saved transaction rather than starting a second payment.
  for (let attempt = 0; attempt < 30; attempt++) {
    const status = await tidepool.status(address);
    if (status.status !== leg.status?.status)
      log({ depositAddress: address, status: status.status });
    leg.status = status;
    await save(state);
    if (status.status === 'SUCCESS') return status;
    if (status.status === 'FAILED' || status.status === 'REFUNDED') {
      throw new Error(
        `Pilot stopped: ${status.status}. Inspect saved public status; no new payment was created.`,
      );
    }
    await sleep(10_000);
  }
  throw new Error('Swap still pending. Re-run --run to resume the same payment.');
}

async function verifyPayment(leg: Leg, merchant: string) {
  const hashes = tidepoolNearSettlementHashes(leg.status!);
  if (!hashes.length) throw new Error('No settlement transaction evidence');
  let amount = 0n;
  for (const hash of hashes) {
    const tx = await nearRpc<{
      final_execution_status: string;
      status: { Failure?: unknown };
      receipts_outcome: {
        id: string;
        outcome: {
          executor_id: string;
          logs: string[];
          status: { SuccessValue?: string; SuccessReceiptId?: string };
        };
      }[];
    }>('EXPERIMENTAL_tx_status', {
      tx_hash: hash,
      sender_account_id: TIDEPOOL_VERIFIER,
      wait_until: 'FINAL',
    });
    if (tx.final_execution_status !== 'FINAL' || tx.status.Failure)
      throw new Error('Settlement transaction is not successful and final');
    const receipts: TxReceipt[] = tx.receipts_outcome.map((r) => ({
      receiptId: r.id,
      executorId: r.outcome.executor_id,
      logs: r.outcome.logs,
      ok:
        r.outcome.status.SuccessValue !== undefined ||
        r.outcome.status.SuccessReceiptId !== undefined,
    }));
    amount += matchingCredits(receipts, {
      assetId: tokens.nearUsdt.assetId,
      receiver: merchant,
      intentsContract: TIDEPOOL_VERIFIER,
    }).reduce((total, credit) => total + credit.amount, 0n);
  }
  if (amount < 1_000_000n)
    throw new Error('Final receipts do not prove the expected merchant credit');
  leg.verified = { hashes, amount: amount.toString(), verifiedAt: new Date().toISOString() };
}

function softwareFixtureSignature(payload: string, publicKey: string, privateKeyPem: string) {
  const client = JSON.stringify({
    type: 'webauthn.get',
    challenge: payloadChallenge(payload),
    origin: 'https://app.usetendr.tech',
    crossOrigin: false,
  });
  const auth = Buffer.concat([sha('usetendr.tech'), Buffer.from([5, 0, 0, 0, 1])]);
  return signedIntent(payload, publicKey, {
    clientDataJSON: Buffer.from(client).toString('base64url'),
    authenticatorData: auth.toString('base64url'),
    signature: sign(
      'sha256',
      Buffer.concat([auth, sha(client)]),
      createPrivateKey(privateKeyPem),
    ).toString('base64url'),
  });
}

async function pay(state: State, merchant: string, customer: Keypair) {
  if (state.payment?.verified) return;
  if (!state.payment) {
    const quote = await tidepool.quote({
      dry: false,
      swapType: 'EXACT_OUTPUT',
      slippageTolerance: 100,
      originAsset: tokens.solUsdc.assetId,
      destinationAsset: tokens.nearUsdt.assetId,
      amount: '1000000',
      depositType: 'ORIGIN_CHAIN',
      refundType: 'ORIGIN_CHAIN',
      refundTo: customer.publicKey.toBase58(),
      recipient: merchant,
      recipientType: 'INTENTS',
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    if (!quote.quote.depositAddress || quote.quote.depositMemo)
      throw new Error('Unexpected deposit instructions');
    if (
      BigInt(quote.quote.amountIn) <= 0n ||
      BigInt(quote.quote.amountIn) > 2_000_000n ||
      quote.quote.amountOut !== '1000000'
    )
      throw new Error('Payment exceeds the two-test-token spend cap');
    state.payment = { quote };
    await save(state);
    log({ paymentQuote: quote });
  }
  const leg = state.payment;
  if (!leg.transaction) {
    if (!(Date.parse(leg.quote.quote.deadline ?? '') > Date.now()))
      throw new Error('Payment quote expired before signing');
    const mint = new PublicKey(tokens.solUsdc.contract);
    const receiver = new PublicKey(leg.quote.quote.depositAddress!);
    const sourceAta = getAssociatedTokenAddressSync(mint, customer.publicKey);
    const destinationAta = getAssociatedTokenAddressSync(mint, receiver);
    const block = await sol.getLatestBlockhash('finalized');
    const transaction = new Transaction({ feePayer: customer.publicKey, ...block }).add(
      createAssociatedTokenAccountIdempotentInstruction(
        customer.publicKey,
        destinationAta,
        receiver,
        mint,
      ),
      createTransferCheckedInstruction(
        sourceAta,
        mint,
        destinationAta,
        customer.publicKey,
        BigInt(leg.quote.quote.amountIn),
        6,
      ),
    );
    transaction.sign(customer);
    leg.transaction = {
      raw: transaction.serialize().toString('base64'),
      signature: bs58.encode(transaction.signature!),
      lastValidBlockHeight: block.lastValidBlockHeight,
    };
    await save(state); // Persist BEFORE network submission: retries use the identical signed bytes.
  }
  const transaction = leg.transaction;
  const previous = (
    await sol.getSignatureStatuses([transaction.signature], { searchTransactionHistory: true })
  ).value[0];
  if (previous?.err)
    throw new Error('Saved Solana deposit failed; inspect it before creating another');
  if (!previous) {
    if ((await sol.getBlockHeight('finalized')) > transaction.lastValidBlockHeight) {
      throw new Error(
        'Saved Solana transaction expired or has unknown history. Manual reconciliation required; refusing a second payment.',
      );
    }
    await sol.sendRawTransaction(Buffer.from(transaction.raw, 'base64'), {
      skipPreflight: false,
      maxRetries: 2,
    });
  }
  if (previous?.confirmationStatus !== 'finalized') {
    const result = await sol.confirmTransaction(
      {
        signature: transaction.signature,
        blockhash: Transaction.from(Buffer.from(transaction.raw, 'base64')).recentBlockhash!,
        lastValidBlockHeight: transaction.lastValidBlockHeight,
      },
      'finalized',
    );
    if (result.value.err) throw new Error('Solana deposit transaction failed');
  }
  log({ solanaDeposit: transaction.signature });
  if (!leg.notified) {
    await tidepool.submitDeposit(transaction.signature, leg.quote.quote.depositAddress!);
    leg.notified = true;
    await save(state);
  }
  await waitForSwap(leg, state);
  await verifyPayment(leg, merchant);
  await save(state);
  log({ paymentVerified: leg.verified });
}

async function withdraw(state: State, merchant: string, publicKey: string) {
  if (!state.payment?.verified) throw new Error('Verify the merchant payment before withdrawing');
  if (state.withdrawal?.verified) return;
  if (!state.withdrawal) {
    const quote = await tidepool.quote({
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: tokens.nearUsdt.assetId,
      destinationAsset: tokens.baseUsdc.assetId,
      amount: '1000000',
      depositType: 'INTENTS',
      refundType: 'INTENTS',
      refundTo: merchant,
      recipient: state.withdrawalBase.address,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    if (
      !quote.quote.depositAddress ||
      quote.quote.depositMemo ||
      quote.quote.amountIn !== '1000000'
    )
      throw new Error('Unexpected withdrawal instructions');
    state.withdrawal = { quote };
    await save(state);
    log({ withdrawalQuote: quote });
  }
  const leg = state.withdrawal;
  if (!leg.signed) {
    const payload = tidepoolTransferPayload({
      signerId: merchant,
      depositAddress: leg.quote.quote.depositAddress!,
      asset: tokens.nearUsdt.assetId,
      amount: leg.quote.quote.amountIn,
      expiresAt: new Date(
        Math.min(Date.parse(leg.quote.quote.deadline!), Date.now() + 10 * 60_000),
      ),
    });
    leg.signed = softwareFixtureSignature(payload, publicKey, state.merchant.privateKeyPem);
    const simulated = await view<{ intents_executed?: unknown[]; invariant_violated?: unknown }>(
      'simulate_intents',
      { signed: [leg.signed] },
    );
    if (simulated.intents_executed?.length !== 1 || simulated.invariant_violated)
      throw new Error('Verifier rejected the withdrawal simulation');
    await save(state);
  }
  if (!leg.intentHash && !leg.submissionAttemptedAt) {
    // An ambiguous relay response must be reconciled via status, never replaced with a new nonce.
    leg.submissionAttemptedAt = new Date().toISOString();
    await save(state);
    leg.intentHash = await tidepool.submitIntent(leg.signed);
    await save(state);
    log({ withdrawalIntentHash: leg.intentHash });
  }
  await waitForSwap(leg, state);
  const hashes = [
    ...new Set(leg.status!.swapDetails.destinationChainTxHashes.map((tx) => tx.hash)),
  ].filter((hash) => /^0x[0-9a-fA-F]{64}$/.test(hash));
  if (!hashes.length) throw new Error('No destination transaction evidence');
  let amount = 0n;
  for (const hash of hashes) {
    const receipt = await base.getTransactionReceipt(hash);
    if (!receipt || receipt.status !== 1 || (await receipt.confirmations()) < 2) {
      throw new Error('Base payout needs two confirmations; re-run --run to verify');
    }
    for (const event of receipt.logs) {
      if (event.address.toLowerCase() !== tokens.baseUsdc.contract.toLowerCase()) continue;
      const decoded = erc20.parseLog(event);
      if (
        decoded?.name === 'Transfer' &&
        String(decoded.args.to).toLowerCase() === state.withdrawalBase.address.toLowerCase()
      ) {
        amount += BigInt(decoded.args.value);
      }
    }
  }
  const minimum = BigInt(leg.quote.quote.minAmountOut ?? leg.quote.quote.amountOut);
  if (minimum <= 0n || amount < minimum)
    throw new Error('Base receipt does not prove the expected payout');
  leg.verified = { hashes, amount: amount.toString(), verifiedAt: new Date().toISOString() };
  await save(state);
  log({ withdrawalVerified: leg.verified });
}

await mkdir(dir, { recursive: true, mode: 0o700 });
const lockPath = `${statePath}.lock`;
const lock = await open(lockPath, 'wx', 0o600);
try {
  if (process.argv.slice(2).some((arg) => arg !== '--run'))
    throw new Error('Usage: verify-tidepool-testnet.ts [--run]');
  const state = await load();
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(state.merchant.publicKeyJwk.x, 'base64url'),
    Buffer.from(state.merchant.publicKeyJwk.y, 'base64url'),
  ]);
  const publicKey = nativePublicKey(
    Buffer.from(p256.ProjectivePoint.fromHex(raw).toRawBytes(true)).toString('base64'),
  );
  const merchant = nativeAccountId(publicKey);
  const customer = Keypair.fromSecretKey(Buffer.from(state.customerSolana.secretKey, 'base64'));
  if (customer.publicKey.toBase58() !== state.customerSolana.address)
    throw new Error('Customer key mismatch');
  await guardNetworks();
  log({
    network: 'testnet',
    customer: customer.publicKey.toBase58(),
    merchant,
    withdrawal: state.withdrawalBase.address,
    solLamports: await sol.getBalance(customer.publicKey),
    merchantUsdt: await view('mt_balance_of', {
      account_id: merchant,
      token_id: tokens.nearUsdt.assetId,
    }),
  });
  if (process.argv.includes('--run')) {
    await pay(state, merchant, customer);
    await withdraw(state, merchant, publicKey);
    log({
      complete: true,
      payment: state.payment!.verified,
      withdrawal: state.withdrawal!.verified,
    });
  }
} finally {
  base.destroy();
  await lock.close();
  await unlink(lockPath);
}
