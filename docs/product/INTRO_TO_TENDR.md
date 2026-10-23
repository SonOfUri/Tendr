# Introducing Tendr

## One checkout. Every way to pay.

Tendr helps apps and businesses make digital-asset payments easier for their customers.

Today, a customer may have the money they want to spend, but not in the exact token or network a business is prepared to accept. That creates friction: customers may need to swap assets, move funds between networks, or abandon the purchase altogether.

Tendr aims to make that experience simpler. A business integrates Tendr once, and its customers can use the payment options supported by Tendr without the business having to build every payment path itself.

**The idea is simple: give businesses one checkout experience, while Tendr handles the payment complexity behind it.**

> **Tendr is a universal checkout and payment-orchestration layer for digital commerce.**

## The problem Tendr addresses

Digital-asset payments can be fragmented. A business may support only certain tokens or networks, while customers hold funds elsewhere. Supporting more options can mean more integrations, more edge cases, and more work for the team building the product.

This can lead to:
- Customers struggling to pay with the assets they already hold.
- Businesses losing purchases when a preferred payment method is unavailable or inconvenient.
- Product teams spending time building and maintaining multiple payment integrations.
- Inconsistent payment experiences across different apps and industries.
- Extra work to confirm whether a payment succeeded before fulfilling an order.

Tendr is being built to reduce that complexity through a common checkout experience and a shared payment workflow.

## How Tendr works

From the customer's perspective, the process should feel familiar:

1. **Choose a product or action.** The customer reaches checkout inside an app or on a website.
2. **Choose a supported way to pay.** Tendr presents the payment options available for that checkout.
3. **Review and authorize.** The customer reviews the payment details and authorizes the transaction through the supported payment flow.
4. **Track the result.** Tendr checks the payment process and presents its status.
5. **Continue with the purchase.** The business can use the payment status to decide when to confirm an order or unlock the relevant experience.

The exact payment options and supported networks depend on the integrations available for the specific deployment. Tendr should only present a payment as successful when its payment-verification process has confirmed the required result.

## The three ways to integrate Tendr

Tendr is one payment platform with three developer-facing integration options. A business can choose the option that best fits its product.

### 1. Tendr Widget

The **Widget** is an embeddable checkout that a business can place inside its own website or application.

It gives customers a ready-made way to review a purchase, select an available payment option, authorize payment, and see the result—without the business having to design the entire checkout experience from scratch.

**Best for:** teams that want to add a checkout experience quickly while retaining their own product and brand experience.

### 2. Tendr API

The **API** lets a business connect Tendr directly to its own backend and user experience.

A team can use it to create checkout sessions, retrieve quotes, check payment status, and receive payment updates. This gives businesses more control over how checkout looks and behaves.

**Best for:** teams building custom checkout flows or integrating payments deeply into an existing product.

### 3. Tendr SDK

The **SDK** is a developer-friendly library that makes it easier to work with Tendr's API from supported programming environments.

It provides reusable helpers and consistent types so developers do not have to repeatedly write the same integration code themselves.

**Best for:** developers who want a more convenient, typed way to integrate Tendr into their applications.

These are not three separate payment products. They are three ways to connect to the same Tendr payment engine.

### Supporting experiences

- **Hosted checkout:** a Tendr-hosted payment page that a business can send customers to when it does not want to build the checkout UI itself.
- **Merchant dashboard:** a place for businesses to review payments and manage integration settings, API keys, and webhook configuration as those capabilities become available.

## Tendr use cases

Tendr is designed for products where a customer needs to make a payment or complete a purchase using supported digital assets. The following are illustrative use cases; availability depends on the relevant product integration and supported payment routes.

### 1. E-commerce

A customer buys a physical or digital product from an online store. The store uses Tendr to offer supported digital-asset payment options and checks the resulting payment status before fulfilling the order.

**Example:** A customer wants to buy a pair of sneakers from a store but holds a supported asset on a different network from the store's preferred payment route. Tendr can coordinate an available payment path where the required assets and route are supported.

### 2. Fintech applications

A fintech app can use Tendr when users need to pay for a service, fund an eligible transaction, or complete an in-app purchase using supported digital assets.

**Example:** A financial application offers a paid feature. Instead of creating and maintaining every supported digital-asset payment path itself, it integrates Tendr's checkout workflow.

### 3. Gaming

A game or gaming platform can use Tendr for eligible purchases such as digital items, access, or upgrades.

**Example:** A player wants to purchase an in-game item. Tendr can provide the payment step, while the game uses the confirmed payment result to decide whether to grant the item.

### 4. Prediction markets and interactive platforms

A prediction-market or interactive platform could use Tendr to collect payment for an eligible action, where the platform and payment route support the required transaction.

**Example:** A user wants to pay to access a supported market-related action. Tendr could coordinate the payment step; the market's own systems remain responsible for the market action itself.

**Important:** Tendr does not automatically execute trades, place bets, or interact with every prediction market. Such actions require separate integrations and must be clearly distinguished from a payment.

### 5. AI-agent purchases — a future direction

As AI agents become able to carry out tasks for users, they may need a safe, controlled way to pay for products or services. Tendr's longer-term direction could include agent-initiated checkout with explicit permissions, spending limits, and auditable payment records.

**Example:** A user authorizes an assistant to purchase an approved digital service up to a defined budget. A future Tendr workflow could help the application initiate and track that payment within the user's configured rules.

This is a future direction, not a claim that autonomous agent payments and spending controls are already available.

## What makes Tendr different?

Tendr's goal is not simply to list more tokens in a checkout. It is to give product teams a reusable way to connect payment choice, payment execution, verification, and the next step in their own application.

Its intended value is:

- **One integration:** reduce the need to build a separate checkout for every supported payment path.
- **A familiar customer experience:** keep payment inside the product journey rather than making customers navigate unnecessary complexity.
- **Flexible integration:** offer a widget, API, or SDK depending on the team's needs.
- **Payment-aware workflows:** help the business distinguish a pending payment from one that has been confirmed.
- **A foundation for new commerce experiences:** support conventional app checkout today, with potential for controlled AI-agent purchasing in the future.

The long-term differentiation will depend on the quality of integrations, the reliability of payment verification, developer experience, and the usefulness of merchant workflows—not just the number of networks or assets supported.

## Where NEAR Intents fits

Tendr is the product and merchant-facing checkout layer. NEAR Intents may be used behind the scenes as part of the payment-routing and execution infrastructure for supported routes.

Customers and merchants should experience Tendr as the checkout product. NEAR Intents is an underlying technology option, not the Tendr brand or the whole product.

Support for a particular asset, network, or payment route depends on the integrations, liquidity, and execution options available. Tendr should not claim universal support unless it has been verified.

## What Tendr is—and is not

**Tendr is:**
- A checkout and payment-orchestration layer for digital commerce.
- A common payment workflow that businesses can integrate through a Widget, API, or SDK.
- A way to coordinate supported payment routes and communicate payment status to the integrating application.

**Tendr is not automatically:**
- A bank or a fiat-payment provider.
- A custodian of every asset a customer may hold.
- A guarantee that every token or network is supported.
- A replacement for a merchant's inventory, order management, or fulfillment systems.
- A prediction-market engine or trading platform.
- A fully autonomous AI purchasing agent today.

Specific custody, fiat settlement, compliance, refunds, chargebacks, and merchant payout capabilities must be described according to what is actually implemented and supported.

## The product experience at a glance

| Audience | What Tendr offers |
|---|---|
| Customers | A clearer way to pay using the options supported for a checkout |
| Merchants | A shared payment workflow and a confirmed payment result they can use in their order process |
| Developers | A Widget, API, and SDK to integrate Tendr at the level of control they need |
| Product teams | Less need to maintain separate payment flows for every supported route |
| Future AI applications | A potential foundation for authorized, policy-controlled purchases |

## The vision

Tendr wants to make paying for something feel simpler than figuring out how the money gets there.

A customer should be able to focus on what they are buying. A merchant should be able to focus on serving that customer. Developers should not have to rebuild the same payment orchestration for every product.

**One checkout. Every way to pay.**

Tendr is building toward a world where digital commerce can accept more of the ways people hold and move value—through one clear, dependable integration.
