export interface QuoteRequest {
  amount: string;
  currency: string;
  sourceAsset?: string;
  sourceNetwork?: string;
}

export interface QuoteResult {
  sourceAsset: string;
  sourceNetwork: string;
  destinationAsset: string;
  destinationNetwork: string;
  sourceAmount: string;
  destinationAmount: string;
  expiresAt: Date;
  provider: string;
}

export interface PaymentStartResult {
  providerReference: string;
}

export interface PaymentVerifyResult {
  status: 'PROCESSING' | 'SETTLED' | 'FAILED';
  providerReference: string;
  failureReason?: string;
}

export interface QuoteProvider {
  createQuote(input: QuoteRequest): Promise<QuoteResult>;
}

export interface PaymentProvider {
  readonly name: string;
  startPayment(input: {
    sessionId: string;
    quoteId: string;
    amount: string;
    currency: string;
  }): Promise<PaymentStartResult>;
}

export interface PaymentVerifier {
  verify(providerReference: string): Promise<PaymentVerifyResult>;
}

export interface WebhookSigner {
  sign(payload: string, secret: string, timestamp: number): string;
}

export interface WebhookTransport {
  deliver(url: string, body: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; error?: string }>;
}
