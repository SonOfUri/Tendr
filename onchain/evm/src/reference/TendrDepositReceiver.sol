// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title TendrDepositReceiver
/// @notice Reference contract for Tendr integrator hooks (gasless spec §4). An integrator settles
/// its Tendr payments into its own contract; once a payment has settled there, Tendr's relayer
/// calls `onTendrDeposit` with the payment's details and the `hook_data` the integrator gave at
/// session creation (its player or order reference). This contract shows the checks every
/// integrator contract MUST keep; inherit it and put your own bookkeeping in `_credit`.
///
/// @dev Required checks (keep all of them):
///  1. Sender: only Tendr's published relayer address for this chain (`relayer`) may call.
///  2. Balance: credit at most what arrived and is not yet accounted for:
///     `min(amount, balance(token) − accounted[token])`, then `accounted[token] += credited`.
///     A hook never makes the contract credit money that is not in it.
///  3. Duplicates: each settlement transaction (`txHash`) is notified once.
///  4. Outflows: whatever moves tokens out of the contract (withdrawals, payouts) must lower
///     `accounted[token]` by the same amount in the same transaction, or later deposits are
///     under-credited; never lower it without moving the tokens out, or a hook could over-credit.
///
/// @dev Misattribution limit (read this): the checks above stop a compromised relayer key from
/// crediting money that never arrived, but NOT from crediting it to the wrong reference. With two
/// deposits pending (player A's and player B's), a forged call naming player A and both amounts
/// credits A with B's deposit, and B's own call then credits nothing. The contract cannot tell the
/// deposits apart because the settlement transfer itself carries no reference. Integrators who
/// need stronger guarantees reconcile each credit against Tendr's signed `payment.succeeded` /
/// `hook.succeeded` webhooks (they name the same payment, amount and settlement transaction), or
/// check `txHash` against the actual transfer before releasing value.
///
/// Gas: Tendr deducts its estimate for this call (90k gas on EVM chains) from the payment's own
/// proceeds; keep `_credit` small. Tendr never sends a hook needing more than 300k gas, or costing
/// more than 10 % of the order. A call refused in Tendr's dry run (e.g. the contract is paused) is
/// retried for 3 days; a call that reverts on chain is not retried. Either way the integrator is
/// told once (`hook.failed`) and can resend it.
///
/// Duplicates: refuse a repeated `txHash` with exactly `AlreadyNotified(bytes32)` (as here). On a
/// retry or resend, Tendr reads that error as "already delivered" (an earlier attempt landed)
/// instead of a failure; a custom receiver using another error gets a `hook.failed` instead.
contract TendrDepositReceiver {
    /// @notice Tendr's relayer (`relayer-evm`) address on this chain: the only allowed caller.
    address public immutable relayer;

    /// @notice Per token (address(0): the chain's native coin), how much has been credited.
    mapping(address token => uint256) public accounted;

    /// @notice Settlement transactions already notified.
    mapping(bytes32 txHash => bool) public notified;

    /// @notice One settled payment, as credited.
    /// @param account keccak256(hookData): the integrator's reference.
    /// @param credited What was credited: `amount`, or less when less arrived unaccounted.
    event TendrDeposit(
        bytes32 indexed paymentId,
        bytes32 indexed sessionId,
        bytes32 indexed account,
        address token,
        uint256 amount,
        uint256 credited,
        bytes32 txHash,
        bytes hookData
    );

    error NotRelayer();
    error ZeroAddress();
    error ZeroTxHash();
    error AlreadyNotified(bytes32 txHash);

    constructor(address relayer_) {
        if (relayer_ == address(0)) revert ZeroAddress();
        relayer = relayer_;
    }

    /// @notice Tendr's hook: a payment settled into this contract.
    /// @param paymentId Tendr payment id (`pay_…`), UTF-8 bytes right-padded to 32.
    /// @param sessionId Tendr checkout session id (`ses_…`), UTF-8 bytes right-padded to 32.
    /// @param hookData The session's `hook_data` as JSON (UTF-8), at most 1 KB.
    /// @param token The settlement token; address(0) for the native coin.
    /// @param amount The amount Tendr settled, in the token's base units.
    /// @param txHash The settlement transaction (the transfer into this contract).
    /// @return credited `min(amount, balance − accounted)`.
    function onTendrDeposit(
        bytes32 paymentId,
        bytes32 sessionId,
        bytes calldata hookData,
        address token,
        uint256 amount,
        bytes32 txHash
    ) external returns (uint256 credited) {
        if (msg.sender != relayer) revert NotRelayer();
        if (txHash == bytes32(0)) revert ZeroTxHash();
        if (notified[txHash]) revert AlreadyNotified(txHash);
        notified[txHash] = true;

        credited = _account(token, amount);
        bytes32 account = keccak256(hookData);
        _credit(account, hookData, token, credited);
        emit TendrDeposit(paymentId, sessionId, account, token, amount, credited, txHash, hookData);
    }

    /// @dev Check 2: `min(amount, balance − accounted)`, added to `accounted[token]`.
    function _account(address token, uint256 amount) private returns (uint256 credited) {
        uint256 balance =
            token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
        uint256 done = accounted[token];
        uint256 unaccounted = balance > done ? balance - done : 0;
        credited = amount < unaccounted ? amount : unaccounted;
        accounted[token] = done + credited;
    }

    /// @dev The integrator's own bookkeeping (e.g. a player balance). `credited` may be 0.
    function _credit(bytes32 account, bytes calldata hookData, address token, uint256 credited)
        internal
        virtual {}

    /// @notice Native-coin settlements arrive as plain transfers.
    receive() external payable {}
}
