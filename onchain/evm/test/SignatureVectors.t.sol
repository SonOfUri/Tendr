// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TendrForwarder} from "../src/TendrForwarder.sol";
import {MockUSDT} from "./mocks/Tokens.sol";

// Signatures produced by the TypeScript signing path (ethers `signTypedData` with
// `forwarderDomain` and `TENDR_PAYMENT_TYPES` from the contracts package) must be accepted by the
// contract. The fixture is written and drift-checked by
// packages/contracts/src/forwarder-vectors.test.ts.
contract SignatureVectorsTest is Test {
    string internal constant FIXTURE = "test/fixtures/tendr-payment-vectors.json";

    function test_acceptsSignaturesFromTheTypeScriptSigner() public {
        string memory json = vm.readFile(FIXTURE);
        uint256 count = vm.parseJsonUint(json, ".count");
        assertGt(count, 0, "no vectors");
        address signer = vm.parseJsonAddress(json, ".signer");
        assertEq(
            vm.parseJsonBytes32(json, ".typehash"),
            new TendrForwarder().TENDR_PAYMENT_TYPEHASH(),
            "TypeScript type string differs from the contract's"
        );

        for (uint256 i = 0; i < count; i++) {
            string memory key = string.concat(".vectors[", vm.toString(i), "]");
            uint256 snap = vm.snapshotState();
            _check(json, key, signer);
            vm.revertToState(snap);
        }
    }

    function _check(string memory json, string memory key, address signer) internal {
        TendrForwarder.TendrPayment memory p = _message(json, string.concat(key, ".message"));
        assertEq(p.from, signer, "vector from is not the fixture signer");

        vm.chainId(vm.parseJsonUint(json, string.concat(key, ".chainId")));
        address verifying = vm.parseJsonAddress(json, string.concat(key, ".verifyingContract"));
        deployCodeTo("TendrForwarder.sol:TendrForwarder", verifying);
        TendrForwarder fwd = TendrForwarder(verifying);
        assertEq(
            fwd.DOMAIN_SEPARATOR(),
            vm.parseJsonBytes32(json, string.concat(key, ".domainSeparator")),
            "domain separator differs from the TypeScript one"
        );

        deployCodeTo("Tokens.sol:MockUSDT", p.token);
        MockUSDT token = MockUSDT(p.token);
        token.mint(p.from, p.amount + p.fee);
        vm.prank(p.from);
        token.approve(verifying, p.amount + p.fee);
        vm.warp(p.deadline);

        fwd.payWithApproval(p, vm.parseJsonBytes(json, string.concat(key, ".signature")));

        assertEq(token.balanceOf(p.to), p.amount, "deposit");
        if (p.fee != 0) assertEq(token.balanceOf(p.feeTo), p.fee, "fee");
        assertEq(token.balanceOf(p.from), 0, "shopper");
        assertTrue(fwd.nonceUsed(p.from, p.nonce));
    }

    function _message(string memory json, string memory key)
        internal
        pure
        returns (TendrForwarder.TendrPayment memory p)
    {
        p.token = vm.parseJsonAddress(json, string.concat(key, ".token"));
        p.from = vm.parseJsonAddress(json, string.concat(key, ".from"));
        p.to = vm.parseJsonAddress(json, string.concat(key, ".to"));
        p.amount = vm.parseJsonUint(json, string.concat(key, ".amount"));
        p.fee = vm.parseJsonUint(json, string.concat(key, ".fee"));
        p.feeTo = vm.parseJsonAddress(json, string.concat(key, ".feeTo"));
        p.deadline = vm.parseJsonUint(json, string.concat(key, ".deadline"));
        p.nonce = vm.parseJsonBytes32(json, string.concat(key, ".nonce"));
    }
}
