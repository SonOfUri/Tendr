// Whether the Reown AppKit modal is open, kept by appkit.ts (which subscribes to AppKit's state)
// and read by the checkout without importing the wallet SDK: Esc then belongs to that modal.
let open = false;

export function setWalletModalOpen(value: boolean): void {
  open = value;
}

export function walletModalOpen(): boolean {
  return open;
}
