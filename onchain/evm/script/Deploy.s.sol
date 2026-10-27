// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {TendrForwarder} from "../src/TendrForwarder.sol";

/// Deploys TendrForwarder through the deterministic CREATE2 deployer
/// (0x4e59b44847b379578588920ca78fbf26c0b4956c, which Foundry uses for
/// `new X{salt: ...}()` in scripts). The contract has no constructor arguments
/// and the build pins solc, optimizer settings and `bytecode_hash = "none"`, so
/// the same salt yields the same address on every EVM chain.
///
/// NOT RUN BY CI OR BY ANY TENDR TOOLING. Deploying needs the user's go-ahead
/// and the external review the spec requires before mainnet (§2.3).
///
///   forge script script/Deploy.s.sol --rpc-url <chain> --broadcast --account <deployer>
contract Deploy is Script {
    bytes32 internal constant SALT = keccak256("tendr.forwarder.v1");

    function predicted() public pure returns (address) {
        return vm.computeCreate2Address(
            SALT, keccak256(type(TendrForwarder).creationCode), CREATE2_FACTORY
        );
    }

    function run() external returns (TendrForwarder fwd) {
        address expected = predicted();
        if (expected.code.length != 0) {
            console2.log("TendrForwarder already deployed at", expected);
            return TendrForwarder(expected);
        }
        vm.startBroadcast();
        fwd = new TendrForwarder{salt: SALT}();
        vm.stopBroadcast();
        require(address(fwd) == expected, "Deploy: unexpected CREATE2 address");
        console2.log("TendrForwarder deployed at", address(fwd));
    }
}
