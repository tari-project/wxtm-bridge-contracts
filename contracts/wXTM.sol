// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { OFTUpgradeable } from "@layerzerolabs/oft-evm-upgradeable/contracts/oft/OFTUpgradeable.sol";
import { EIP3009 } from "./extensions/EIP3009.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

contract wXTM is OFTUpgradeable, EIP3009, AccessControlUpgradeable {
    error ZeroAmount();

    bytes32 private constant MINTER_ROLE = keccak256("MINTER_ROLE");

    constructor(address _lzEndpoint) OFTUpgradeable(_lzEndpoint) {
        _disableInitializers();
    }

    function initialize(
        string memory _name,
        string memory _symbol,
        string memory _version,
        address _delegate
    ) external initializer {
        __Ownable_init(_delegate);
        __OFT_init(_name, _symbol, _delegate);
        __EIP712_init(_symbol, _version);
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _delegate);
    }

    /** @dev Mint can only be called by multi-sig-wallets with access control */
    function mint(address _to, uint256 _amount) external onlyRole(MINTER_ROLE) {
        _mint(_to, _amount);
    }

    function burn(uint256 _amount) external {
        if (_amount == 0) revert ZeroAmount();

        _burn(msg.sender, _amount);
    }

    function receiveWithAuthorization(
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
        _receiveWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s);
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
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        _cancelAuthorization(authorizer, nonce, v, r, s);
    }
}
