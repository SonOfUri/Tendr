# Tendr demo — presenter script

**URL:** https://demo.usetendr.tech (or http://localhost:3000)  
**Opens on:** E-commerce (Adidas cart)  
**Timing notes:** Transfer auto-flow ≈ **45s** on QR, then pending checklist → success (~**56s** total). Countdown **pauses** if asset dropdown is open or Connect wallet is selected.

---

## 1. Land — E-commerce (open)

**Do:** Load the demo. Stay on **E-commerce**. Don’t click checkout yet.

**Say:**
> This is Tendr’s interactive playground. You’re looking at a real merchant surface — an Adidas cart — with Tendr’s checkout layered in. Same pattern works for fintech, gaming, and prediction markets. One checkout. Every way to pay.

**Point at:** Cart (items, total **$2,213**), sidebar steps: Cart checkout → Tendr payment → Order confirmation.

---

## 2. Highlight Component / Code

**Do:** Click **Component** (already on), then **Code**, pause, back to **Component**.

**Say:**
> Merchants integrate Tendr through the API and drop in the checkout widget — create a session with amount and currency, then render Tendr. Component view is the merchant experience shoppers see. Code view is how developers wire the API and embed the widget. Same session, both sides.

**Optional (Code):** Scroll the snippet; mention session + widget (`useCheckoutSession` / `<TendrCheckout />`) as the install surface for that API.

---

## 3. Highlight Usecases (tour the four)

**Do:** Point at **Usecases**, then click through once each — don’t start checkout yet:

| Tab | Brand | What to say (one line) |
|-----|--------|-------------------------|
| **E-commerce** | Adidas | Cart → pay → order confirmed. |
| **Fintech** | Pulse Finance | In-app funding — unlock Premium Analytics. |
| **Gaming** | Pixel Forge | Cosmetic unlock only after settlement. |
| **Prediction** | Omni Markets | Stake on Kane vs Mbappé. |

**Say (while flipping):**
> There are a broad array of usecases for Tendr. You can integrate Tendr into anything and everything for payments — store, app, studio, market — same settlement rail underneath, whatever the surface.

**Do:** Return to **E-commerce** before the next beat.

---

## 4. Tendr Checkout — full Transfer flow (E-commerce)

**Say (before you click):**
> Let’s see Tendr in action on an e-commerce checkout — Adidas cart, real purchase flow, end to end.

**Do:**
1. Click **Continue to Payment**.
2. Leave **Transfer** selected.
3. Optionally open **Asset** briefly (BTC/ETH/etc.) — closing resumes the timer.
4. Let the flow play: QR + amount + address → (~45s) **Confirming** checklist → **All set**.

**Say (as it opens):**
> Shopper stays in the merchant experience. Tendr opens as the payment layer — asset, transfer or wallet, locked quote, deposit details.

**Do:** Click the floating **Tendr AI** ghost (bottom-left). Pause on Recommended / Cheapest / Fastest, then tap one. Optionally open **Asset** for a multi-chain row + network.

**Say (Tendr AI):**
> This is Tendr AI — the ghost. It hovers with the checkout and, on tap, scores rails for this payment: recommended, cheapest, and fastest. Multi-chain assets still need an explicit network in the asset picker, because Solana USDC isn’t Ethereum USDC.

**Say (on Transfer / QR):**
> Transfer is the classic path: pick an asset, hold a price window, send the exact amount to the deposit address. No wallet connect required. We’re watching this settle end-to-end for the demo.

**Say (pending modal — Payment detected → Confirming on-chain → Settlement):**
> Once funds are detected, Tendr confirms on-chain and settles. The merchant only moves to “order confirmed” after a verified success state — not on a hope click.

**Say (success):**
> Order confirmed. Fulfillment can proceed. That’s the e-comm loop: cart → Tendr → confirmation.

**Do:** Click **Continue** / close to return to the playground.

---

## 5. Tendr API & SDK — Fintech + Prediction (Connect wallet)

**Do:** Click **Code** once if you want a visual beat, then back to **Component**.

**Say:**
> Under the hood this is the Tendr API and SDK: create a checkout session, lock amount and currency, render checkout, listen for settlement. Merchants don’t rebuild crypto rails per vertical — they call Tendr.

### Fintech (brief)

**Do:** Open **Fintech** (Pulse Finance). Point at dashboard / **+ Fund**. Don’t need a full wait unless you want one.

**Say:**
> Fintech same API — funding an in-app feature instead of a cart. Pulse Finance, Premium Analytics, twenty dollars. One session model, different product copy.

### Prediction Markets — Connect wallet flow

**Do:**
1. Open **Prediction**.
2. Click **Vote Kane** or **Vote Mbappé** ($25 stake).
3. Switch to **Connect wallet**.
4. Walk connect / wallet UI (timer is paused on this tab).
5. You can flip back to **Transfer** if you need the auto-success path for time, or complete wallet UX live if the room allows.

**Say:**
> Prediction markets: pick a side, stake through Tendr. Connect wallet is for shoppers who want to pay from an already connected wallet — Reown / chain-aware — instead of copying an address. Same checkout session; different payment method.

**Say (after):**
> API and SDK stay identical. Transfer vs wallet is a shopper preference on top of one session.

---

## 6. Full customization — Gaming + Transfer (show the skin)

**Do:**
1. Open **Gaming** (Pixel Forge / Nebula Skin / **$9.99**).
2. Optionally open **Customize experience** — change studio name or logo — then close.
3. Start checkout (**Buy** / unlock).
4. Stay on **Transfer**; let the full auto-flow run again (45s → pending → success).

**Say:**
> Gaming is where you feel the customization. Pixel Forge isn’t a generic modal — border, type, copy, “BUYING FROM,” success as unlock. Merchants keep their brand; Tendr keeps settlement.

**Say (during Transfer):**
> Same transfer mechanics as Adidas — quote, deposit, confirm, settle — fully skinned for an in-game purchase. Cosmetic unlocks only after success, so inventory doesn’t lie.

**Say (close):**
> That’s Tendr: one checkout, every way to pay — e-comm, fintech, predictions, gaming — Component and Code, Transfer and wallet, branded end-to-end.

---

## Quick cue card

| Beat | Click | Talk track |
|------|--------|------------|
| Open | E-commerce | Merchant surface + Tendr rail |
| Toggle | Component ↔ Code | SDK + UI |
| Tour | All four usecases | One rail, many skins |
| Checkout #1 | Adidas → Transfer → wait | Full transfer story |
| API/SDK | Code glance → Fintech | Session model |
| Wallet | Prediction → Connect wallet | Wallet path |
| Custom | Gaming → Transfer → wait | Full branded flow |

## Timing (rough)

| Segment | ~Time |
|---------|--------|
| Intro + toggle + usecase tour | 2–3 min |
| E-comm Transfer full flow | ~1 min talk + ~1 min wait |
| API + Fintech + Prediction wallet | 2–3 min |
| Gaming Transfer full flow | ~1 min talk + ~1 min wait |
| **Total** | **~8–12 min** |

*If short on time: skip waiting out the second Transfer — narrate over QR and jump usecases; or open Connect wallet on Prediction (pauses timer) while you talk.*
