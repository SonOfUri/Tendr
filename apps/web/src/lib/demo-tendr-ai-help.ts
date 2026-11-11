/** Shared suggestion chips for demo + live Tendr AI Help. */
export const TENDR_AI_SUGGESTIONS = [
  'How long will this payment take?',
  'What happens if I send the wrong amount?',
  'Can I get a refund?',
] as const;

export type TendrAiHelpReply = {
  answer: string;
  facts: { id: string; text: string }[];
};

const DEMO_REPLIES: Record<string, TendrAiHelpReply> = {
  'How long will this payment take?': {
    answer:
      'Most demo rails confirm in about a minute once the transfer is detected. On a real checkout, ETA depends on the network you pick — Tendr AI’s Routes tab ranks faster options when quotes include a provider estimate.',
    facts: [
      {
        id: 'timing',
        text: 'This is a test demo: after you “send,” the panel moves to confirming, then success on a short timer. No real chain wait.',
      },
      {
        id: 'network',
        text: 'Use the exact token, network, and amount shown on the current quote. The same symbol on another chain is a different route.',
      },
    ],
  },
  'What happens if I send the wrong amount?': {
    answer:
      'Send exactly what’s shown on the quote for that asset and network. Too little can leave the order incomplete; too much or the wrong network can delay settlement. In this demo nothing is broadcast — wrong-amount cases are only illustrated in live checkouts.',
    facts: [
      {
        id: 'underpayment',
        text: 'On a live checkout, an incomplete deposit may offer a top-up. Never invent a new send amount from this chat — follow the checkout instructions.',
      },
      {
        id: 'network',
        text: 'Wrong network or token is a different payment path. Always match the deposit details on screen.',
      },
    ],
  },
  'Can I get a refund?': {
    answer:
      'Refunds are handled by the store against the recorded payment. This demo never moves funds, so there’s nothing to refund here. On a live checkout, ask the store if you need one — Tendr can explain refund status once records exist.',
    facts: [
      {
        id: 'refunds',
        text: 'No refund records exist for this demo session. Contact the store for real-order refund requests.',
      },
      {
        id: 'capabilities',
        text: 'Tendr AI can explain payment and refund state. It cannot send funds, approve a refund, or mark an order paid.',
      },
    ],
  },
};

const FALLBACK: TendrAiHelpReply = {
  answer:
    'I can help with timing, amounts, networks, and refunds for this checkout. For order or delivery questions, contact the store.',
  facts: [
    {
      id: 'unsupported',
      text: 'This demo assistant answers common checkout questions only. It does not have store-specific order details.',
    },
  ],
};

/** Simulated Help answer for the playground Ghost (no API call). */
export function demoTendrAiHelp(question: string): TendrAiHelpReply {
  const trimmed = question.trim();
  if (!trimmed) return FALLBACK;
  const exact = DEMO_REPLIES[trimmed];
  if (exact) return exact;

  const q = trimmed.toLowerCase();
  if (/(how long|eta|time|fast|slow|minute|confirm)/.test(q)) {
    return DEMO_REPLIES['How long will this payment take?']!;
  }
  if (/(wrong|amount|underpay|overpay|too (little|much)|incomplete)/.test(q)) {
    return DEMO_REPLIES['What happens if I send the wrong amount?']!;
  }
  if (/(refund|money back|return)/.test(q)) {
    return DEMO_REPLIES['Can I get a refund?']!;
  }
  return FALLBACK;
}
