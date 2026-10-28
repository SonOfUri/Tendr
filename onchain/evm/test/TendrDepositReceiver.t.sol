// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TendrDepositReceiver} from "../src/reference/TendrDepositReceiver.sol";
import {MockUSDT} from "./mocks/Tokens.sol";

contract TendrDepositReceiverTest is Test {
    TendrDepositReceiver internal r;
    MockUSDT internal usdt;
    address internal relayer = makeAddr("relayerEvm");
    bytes32 internal constant PAY = bytes32("pay_01J00000000000000000000001");
    bytes32 internal constant SES = bytes32("ses_01J00000000000000000000001");
    bytes internal constant PLAYER_A = bytes('{"player":"A"}');
    bytes internal constant PLAYER_B = bytes('{"player":"B"}');

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

    function setUp() public {
        r = new TendrDepositReceiver(relayer);
        usdt = new MockUSDT();
    }

    function _hook(bytes memory data, address token, uint256 amount, bytes32 txHash)
        internal
        returns (uint256)
    {
        vm.prank(relayer);
        return r.onTendrDeposit(PAY, SES, data, token, amount, txHash);
    }

    function test_rejectsAZeroRelayer() public {
        vm.expectRevert(TendrDepositReceiver.ZeroAddress.selector);
        new TendrDepositReceiver(address(0));
    }

    function test_onlyTheRelayerMayCall() public {
        usdt.mint(address(r), 100e6);
        vm.expectRevert(TendrDepositReceiver.NotRelayer.selector);
        r.onTendrDeposit(PAY, SES, PLAYER_A, address(usdt), 100e6, keccak256("tx1"));
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(TendrDepositReceiver.NotRelayer.selector);
        r.onTendrDeposit(PAY, SES, PLAYER_A, address(usdt), 100e6, keccak256("tx1"));
        assertEq(r.accounted(address(usdt)), 0);
    }

    function test_creditsTheSettledAmountAndEmits() public {
        usdt.mint(address(r), 100e6);
        vm.expectEmit(address(r));
        emit TendrDeposit(
            PAY, SES, keccak256(PLAYER_A), address(usdt), 100e6, 100e6, keccak256("tx1"), PLAYER_A
        );
        assertEq(_hook(PLAYER_A, address(usdt), 100e6, keccak256("tx1")), 100e6);
        assertEq(r.accounted(address(usdt)), 100e6);
        assertTrue(r.notified(keccak256("tx1")));
    }

    function test_aForgedAmountAboveTheUnaccountedBalanceCreditsOnlyTheRealBalance() public {
        usdt.mint(address(r), 60e6);
        assertEq(_hook(PLAYER_A, address(usdt), 100e6, keccak256("tx1")), 60e6);
        assertEq(r.accounted(address(usdt)), 60e6);
        // Nothing new arrived: a further (forged) hook credits nothing.
        assertEq(_hook(PLAYER_A, address(usdt), 50e6, keccak256("tx2")), 0);
        assertEq(r.accounted(address(usdt)), 60e6);
        // A later deposit is credited normally.
        usdt.mint(address(r), 25e6);
        assertEq(_hook(PLAYER_B, address(usdt), 25e6, keccak256("tx3")), 25e6);
        assertEq(r.accounted(address(usdt)), 85e6);
    }

    function test_aDuplicateTxHashIsRefused() public {
        usdt.mint(address(r), 200e6);
        _hook(PLAYER_A, address(usdt), 100e6, keccak256("tx1"));
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(TendrDepositReceiver.AlreadyNotified.selector, keccak256("tx1"))
        );
        r.onTendrDeposit(PAY, SES, PLAYER_B, address(usdt), 100e6, keccak256("tx1"));
        assertEq(r.accounted(address(usdt)), 100e6);
    }

    function test_aZeroTxHashIsRefused() public {
        usdt.mint(address(r), 1e6);
        vm.prank(relayer);
        vm.expectRevert(TendrDepositReceiver.ZeroTxHash.selector);
        r.onTendrDeposit(PAY, SES, PLAYER_A, address(usdt), 1e6, bytes32(0));
    }

    function test_nativeCoinSettlements() public {
        vm.deal(address(this), 2 ether);
        (bool ok,) = address(r).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(_hook(PLAYER_A, address(0), 3 ether, keccak256("tx1")), 1 ether);
        assertEq(r.accounted(address(0)), 1 ether);
    }

    /// The documented limit: with two deposits pending, a forged hook can credit player A with
    /// player B's deposit (never more than arrived in total).
    function test_misattributionIsBoundedByTheBalance() public {
        usdt.mint(address(r), 100e6); // A's deposit
        usdt.mint(address(r), 100e6); // B's deposit
        assertEq(_hook(PLAYER_A, address(usdt), 200e6, keccak256("forged")), 200e6);
        assertEq(_hook(PLAYER_B, address(usdt), 100e6, keccak256("txB")), 0);
        assertEq(r.accounted(address(usdt)), 200e6);
    }

    /// Accounting above the balance (tokens left without lowering `accounted`) never underflows.
    function test_aBalanceBelowAccountedCreditsNothing() public {
        usdt.mint(address(r), 100e6);
        _hook(PLAYER_A, address(usdt), 100e6, keccak256("tx1"));
        vm.prank(address(r));
        usdt.transfer(makeAddr("elsewhere"), 40e6);
        usdt.mint(address(r), 10e6);
        assertEq(_hook(PLAYER_A, address(usdt), 10e6, keccak256("tx2")), 0);
    }

    function testFuzz_neverCreditsMoreThanArrived(uint128 arrived, uint128 claimed, uint8 hooks)
        public
    {
        usdt.mint(address(r), arrived);
        uint256 total;
        for (uint256 i; i < uint256(hooks) % 8 + 1; i++) {
            total += _hook(PLAYER_A, address(usdt), claimed, keccak256(abi.encode(i)));
        }
        assertLe(total, arrived);
        assertEq(r.accounted(address(usdt)), total);
    }

    /// The full transaction gas of one hook call: the 21k base, the calldata and the execution
    /// (minus the cold-account surcharge of the test's own CALL: a transaction's `to` is warm).
    function _txGas(bytes memory hookData, bytes32 txHash) internal returns (uint256) {
        bytes memory call =
            abi.encodeCall(r.onTendrDeposit, (PAY, SES, hookData, address(usdt), 100e6, txHash));
        uint256 calldataGas;
        for (uint256 i; i < call.length; i++) {
            calldataGas += call[i] == 0 ? 4 : 16;
        }
        vm.prank(relayer);
        uint256 before = gasleft();
        (bool ok,) = address(r).call(call);
        uint256 exec = before - gasleft();
        assertTrue(ok);
        return 21_000 + calldataGas + exec - 2_600;
    }

    /// The API's estimate (HOOK_GAS_UNITS, apps/api/src/gas/fees.ts) covers a typical call (a
    /// fresh `notified` slot, `accounted` already non-zero). The token's very first deposit (a
    /// fresh `accounted` slot) and a 1 KB hook_data cost more: logged here; the excess over the
    /// estimate is Tendr's loss (ruling T11-a).
    function test_gasOfAHookCall() public {
        bytes memory typical = bytes('{"player":"p-42","order":"A-1001"}');
        usdt.mint(address(r), 300e6);
        uint256 first = _txGas(typical, keccak256("tx1"));
        uint256 steady = _txGas(typical, keccak256("tx2"));
        bytes memory big = new bytes(1024);
        for (uint256 i; i < big.length; i++) {
            big[i] = "x";
        }
        uint256 largest = _txGas(big, keccak256("tx3"));
        emit log_named_uint("first deposit of a token", first);
        emit log_named_uint("typical (steady state)", steady);
        emit log_named_uint("steady state, 1 KB hook_data", largest);
        assertLt(steady, 90_000);
    }
}
