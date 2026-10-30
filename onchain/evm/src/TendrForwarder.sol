// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// EIP-3009 (USDC `FiatTokenV2`): the two functions the forwarder calls.
interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @title TendrForwarder
/// @notice Relays shopper-signed gasless payments (EVM and Tron): the payment goes to the 1Click
/// deposit address and the optional network fee to Tendr's gas-fee address, in one transaction.
/// Every destination and amount is bound by the shopper's own signature, so whoever submits the
/// call (a Tendr relayer or anyone else) can only execute what the shopper signed.
/// @dev Immutable: no owner, no admin, no `receive`/`fallback`, no storage except used nonces.
/// Tokens move straight from the shopper to the signed recipients; the forwarder never holds any.
/// Fee-on-transfer and rebasing tokens are unsupported (the deposit address would receive less than
/// `amount`); the API's token allow-list must exclude them.
contract TendrForwarder is EIP712 {
    using SafeERC20 for IERC20;

    /// @notice keccak256 of the `TendrPayment` EIP-712 type string.
    bytes32 public constant TENDR_PAYMENT_TYPEHASH = keccak256(
        "TendrPayment(address token,address from,address to,uint256 amount,uint256 fee,address feeTo,uint256 deadline,bytes32 nonce)"
    );

    /// @notice What the shopper signs for the permit and approval paths.
    /// @param to The 1Click deposit address.
    /// @param fee The network fee in `token` base units; 0 when the merchant sponsors.
    /// @param feeTo Tendr's gas-fee address (ignored when `fee == 0`).
    /// @param deadline Last valid `block.timestamp` (inclusive).
    /// @param nonce Random 32 bytes, single use per `from`.
    struct TendrPayment {
        address token;
        address from;
        address to;
        uint256 amount;
        uint256 fee;
        address feeTo;
        uint256 deadline;
        bytes32 nonce;
    }

    /// @notice An EIP-2612 permit from `owner` to this forwarder.
    struct Permit {
        address token;
        address owner;
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice A signed EIP-3009 `TransferWithAuthorization`. A leg with `value == 0` is empty.
    struct Auth3009 {
        address token;
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice A payment went through this forwarder. NOT proof of payment: anyone can call with a
    /// token they deployed, and a skipped EIP-3009 leg logs caller-supplied fields. Payment is
    /// detected by the watcher; consumers must filter by allow-listed token and check transfers.
    /// @dev `amount` and `fee` are what this call moved
    /// (a leg already executed by someone else, EIP-3009 only, counts as 0). `nonce` is the
    /// `TendrPayment` nonce, or the payment leg's EIP-3009 nonce.
    event TendrPaid(
        address indexed from,
        address indexed token,
        address indexed to,
        uint256 amount,
        uint256 fee,
        bytes32 nonce
    );

    /// @notice An EIP-3009 leg was skipped because its authorization was already used or cancelled
    /// (front-run: the transfer already happened to the signed destination).
    event AuthorizationSkipped(address indexed token, address indexed from, bytes32 indexed nonce);

    error InvalidSignature();
    error Expired(uint256 deadline);
    error NonceUsed(address from, bytes32 nonce);
    error InsufficientAllowance(uint256 allowance, uint256 needed);
    error PermitMismatch();
    error InvalidRecipient();
    error ZeroAmount();

    mapping(address from => mapping(bytes32 nonce => bool)) private _usedNonces;

    constructor() EIP712("TendrForwarder", "1") {}

    /// @notice The EIP-712 domain separator (name "TendrForwarder", version "1").
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Whether `from` has used `nonce` for a `TendrPayment`.
    function nonceUsed(address from, bytes32 nonce) external view returns (bool) {
        return _usedNonces[from][nonce];
    }

    /// @notice EIP-3009 path: executes the payment leg and the (optional) fee leg. A leg whose
    /// authorization is already used is skipped, so a front-run leg never blocks the other one.
    function payWithAuthorizations(Auth3009 calldata payment, Auth3009 calldata fee) external {
        if (payment.value == 0) revert ZeroAmount();
        uint256 paid = _executeAuthorization(payment);
        uint256 feePaid = fee.value == 0 ? 0 : _executeAuthorization(fee);
        // The amounts depend on the token calls; a reentrant token can only affect its own logs.
        // forge-lint: disable-next-line(reentrancy-events)
        emit TendrPaid(payment.from, payment.token, payment.to, paid, feePaid, payment.nonce);
    }

    /// @notice EIP-2612 path: applies the permit (tolerating a front-run one), then pays `p`.
    function payWithPermit(Permit calldata permit, TendrPayment calldata p, bytes calldata sig)
        external
    {
        // The permit is for exactly amount + fee, so nothing is left approved (spec §2.3).
        if (permit.token != p.token || permit.owner != p.from || permit.value != p.amount + p.fee) {
            revert PermitMismatch();
        }
        // A front-run permit reverts here but has already set the allowance; `_pay` checks it.
        try IERC20Permit(p.token)
            .permit(
                p.from, address(this), permit.value, permit.deadline, permit.v, permit.r, permit.s
            ) {}
            catch {}
        _pay(p, sig);
    }

    /// @notice Approval path (Tron, approve-based tokens): pays `p` from the shopper's allowance.
    function payWithApproval(TendrPayment calldata p, bytes calldata sig) external {
        _pay(p, sig);
    }

    function _executeAuthorization(Auth3009 calldata a) private returns (uint256) {
        if (a.to == address(this)) revert InvalidRecipient();
        IERC3009 token = IERC3009(a.token);
        if (token.authorizationState(a.from, a.nonce)) {
            // forge-lint: disable-next-line(reentrancy-events)
            emit AuthorizationSkipped(a.token, a.from, a.nonce);
            return 0;
        }
        token.transferWithAuthorization(
            a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s
        );
        return a.value;
    }

    function _pay(TendrPayment calldata p, bytes calldata sig) private {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > p.deadline) revert Expired(p.deadline);
        if (p.amount == 0) revert ZeroAmount();
        if (p.to == address(this) || (p.fee != 0 && p.feeTo == address(this))) {
            revert InvalidRecipient();
        }

        bytes32 structHash = keccak256(
            abi.encode(
                TENDR_PAYMENT_TYPEHASH,
                p.token,
                p.from,
                p.to,
                p.amount,
                p.fee,
                p.feeTo,
                p.deadline,
                p.nonce
            )
        );
        // Reverts on malformed or high-s (malleable) signatures.
        if (ECDSA.recover(_hashTypedDataV4(structHash), sig) != p.from) revert InvalidSignature();

        if (_usedNonces[p.from][p.nonce]) revert NonceUsed(p.from, p.nonce);
        _usedNonces[p.from][p.nonce] = true;
        // Effects before interactions: the nonce is spent and the event logged before any token
        // call; a revert below rolls both back. (In `payWithPermit` the permit call comes first;
        // a reentrant token can only affect its own logs.)
        // forge-lint: disable-next-line(reentrancy-events)
        emit TendrPaid(p.from, p.token, p.to, p.amount, p.fee, p.nonce);

        IERC20 token = IERC20(p.token);
        uint256 needed = p.amount + p.fee;
        uint256 allowance = token.allowance(p.from, address(this));
        if (allowance < needed) revert InsufficientAllowance(allowance, needed);

        // `from` is arbitrary by design: it is the verified signer of `p`, and only the signed
        // recipients and amounts are used.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        token.safeTransferFrom(p.from, p.to, p.amount);
        if (p.fee != 0) {
            // forge-lint: disable-next-line(arbitrary-send-erc20)
            token.safeTransferFrom(p.from, p.feeTo, p.fee);
        }
    }
}
