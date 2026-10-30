// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// EIP-2612 token (stands in for permit tokens such as DAI-style or USDC permit).
contract MockPermitToken is ERC20Permit {
    constructor() ERC20("Permit Token", "PRM") ERC20Permit("Permit Token") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// EIP-3009 token modelled on USDC's FiatTokenV2 `transferWithAuthorization`.
contract MockEIP3009Token is ERC20, EIP712 {
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    constructor() ERC20("USD Coin", "USDC") EIP712("USD Coin", "2") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

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
    ) external {
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(
            !_authorizationStates[from][nonce], "FiatTokenV2: authorization is used or canceled"
        );
        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        require(
            ECDSA.recover(_hashTypedDataV4(structHash), v, r, s) == from,
            "FiatTokenV2: invalid signature"
        );
        _authorizationStates[from][nonce] = true;
        _transfer(from, to, value);
    }
}

/// USDT-style token: `transfer`, `transferFrom` and `approve` return nothing,
/// and `approve` refuses to change a non-zero allowance to another non-zero value.
contract MockUSDT {
    string public constant name = "Tether USD";
    string public constant symbol = "USDT";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 value) external {
        require(value == 0 || allowance[msg.sender][spender] == 0, "USDT: reset allowance first");
        allowance[msg.sender][spender] = value;
    }

    function transfer(address to, uint256 value) external {
        require(balanceOf[msg.sender] >= value, "USDT: balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
    }

    function transferFrom(address from, address to, uint256 value) external {
        require(allowance[from][msg.sender] >= value, "USDT: allowance");
        require(balanceOf[from] >= value, "USDT: balance");
        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}
