# Tendr invoicing demo — presenter script

**URL:** https://invoicing.demo.usetendr.tech (local: http://localhost:3000/invoicing-demo)  
**Opens on:** Claire Bennett’s invoice link. Three chapters, not one blended flow.  
**Skip:** Shift+Alt+N jumps to the next beat. On the last beat it replays from the link.  
**What this is:** Accounts payable. A contractor bills the business in USDC on NEAR. The business pays in ETH on Ethereum. NEAR Intents does the swap.

Cast: **Claire Bennett** bills **Northline** **4,800 USDC** to `claire.near`. Northline pays **1.62 ETH** on Ethereum.

The right rail only has three stops: Contractor, Merchant, Settlement. The pill above each card names who you are watching.

---

## 1. Contractor — Claire

**Link.** A browser chip shows `invoice.usetendr.tech/northline`. The cursor clicks **Open link**.

**Say:**
> This is the contractor. Claire has no Tendr account. Northline sent her a link.

**Write.** The whole invoice stays on screen. The cursor types her name, email, and lines, and uses the asset picker for USDC on NEAR.

**Confirm.** This is Claire’s own email, `claire@bennett.studio`. She verifies. Northline has not seen it yet.

---

## 2. Merchant — Northline

The pill switches to Northline. This is a different inbox: `finance@northline.com`.

**Say:**
> Now we leave Claire. This is the business. Tendr delivered the bill to their finance inbox.

The cursor opens the Tendr email, then clicks **Pay from wallet**. The quote and the passkey are Northline signing. That signature starts the payout. It does not finish it.

---

## 3. Settlement — the bridge

Both people are on screen. Northline is on the left, holding ETH on Ethereum. Claire is on the right, waiting for USDC on NEAR. The line between them is NEAR Intents.

**Say:**
> Northline does not hold USDC. They send 1.62 ETH on Ethereum. NEAR Intents swaps it, and 4,800 USDC arrives at claire.near.

Watch the chip. It leaves as ETH, flips to USDC on the intent, then lands on Claire. Her balance becomes 4,800 USDC. Northline’s ETH balance drops to 6.77. Both badges read paid.

**Do:** Let it hold. Replay starts again from Claire’s link.
