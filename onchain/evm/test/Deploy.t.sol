// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {TendrForwarder} from "../src/TendrForwarder.sol";

/// Runs the deploy script inside the local test EVM only (no RPC, nothing broadcast).
contract DeployTest is Test {
    function test_deploysToThePredictedCreate2Address() public {
        Deploy script = new Deploy();
        address expected = script.predicted();
        TendrForwarder fwd = script.run();
        assertEq(address(fwd), expected);
        assertGt(address(fwd).code.length, 0);
        // Idempotent: a second run finds the existing deployment.
        assertEq(address(script.run()), expected);
    }
}
