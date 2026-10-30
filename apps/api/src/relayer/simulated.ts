// The test-mode relayer (project 5a, spec §3.3): the same options, payloads, checks, budget
// reservations and `gas_sponsorships` records as live, with no RPC, no gas and no Pimlico. A
// submission is "mined" at once (a deterministic fake hash) and the deposit reaches the simulated
// 1Click, so the watcher detects the payment exactly as it would live.
import { simulatedOneClick } from '../checkout/oneclick/index.js';
import { SIMULATED_FEE_USD } from '../gas/fees.js';
import { log } from '../lib/logger.js';
import {
  applyRelayOutcome,
  simulatedRelayTxHash,
  submissionStatus,
  submitRelayed,
  type RelayCall,
} from './submissions.js';
import type {
  ChainFamily,
  GaslessContext,
  GaslessOption,
  GaslessRelayer,
  PrepareInput,
  PreparePayload,
  QuoteContext,
  SignedPayload,
  SubmissionStatus,
  SubmitResult,
} from './types.js';

/** The chain logic a family shares between live and test mode. */
export interface RelayPlanner {
  options(c: GaslessContext): Promise<GaslessOption[]>;
  prepare(q: QuoteContext, input: PrepareInput): Promise<PreparePayload>;
  verify(q: QuoteContext, signed: SignedPayload): Promise<RelayCall>;
}

/** Simulated gas used by one relayed payment (display only). */
export const SIMULATED_GAS_USED = 120_000n;

export class SimulatedRelayer implements GaslessRelayer {
  constructor(
    readonly family: ChainFamily,
    private readonly planner: RelayPlanner,
  ) {}

  options(c: GaslessContext): Promise<GaslessOption[]> {
    return this.planner.options(c);
  }

  prepare(q: QuoteContext, input: PrepareInput): Promise<PreparePayload> {
    return this.planner.prepare(q, input);
  }

  async submit(q: QuoteContext, signed: SignedPayload): Promise<SubmitResult> {
    const res = await submitRelayed(
      q,
      signed,
      (qq, s) => this.planner.verify(qq, s),
      async (_call, submission) => ({ txHash: simulatedRelayTxHash(submission.id) }),
    );
    if (res.status !== 'submitted') return res;
    await applyRelayOutcome(res.submissionId, {
      status: 'confirmed',
      txHash: res.txHash ?? null,
      gasUsed: SIMULATED_GAS_USED,
      costUsd: SIMULATED_FEE_USD[q.origin.blockchain] ?? null,
      reason: null,
      // The simulated transaction moves exactly the signed fee leg.
      feeMoved:
        q.quote.networkFeePaidBy === 'buyer' && q.quote.networkFeeAmount
          ? BigInt(q.quote.networkFeeAmount.toFixed(0))
          : null,
    });
    try {
      // The relayed transaction moved the payment to the deposit address.
      await simulatedOneClick().simulate(q.quote.depositAddress, 'exact', {
        senderAddress: q.quote.walletAddress!,
      });
    } catch (err) {
      log('warn', 'simulated relay: deposit simulation failed', {
        submissionId: res.submissionId,
        err: String(err),
      });
    }
    return { ...res, status: 'confirmed' };
  }

  status(submissionId: string): Promise<SubmissionStatus> {
    return submissionStatus(submissionId);
  }
}
