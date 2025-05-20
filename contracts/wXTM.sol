// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { OFTUpgradeable } from "@layerzerolabs/oft-evm-upgradeable/contracts/oft/OFTUpgradeable.sol";
import { EIP3009 } from "./extensions/EIP3009.sol";

import { IwXTMController } from "./interfaces/IwXTMController.sol";

contract wXTM is OFTUpgradeable, EIP3009 {
    error ZeroAmount();
    error Unauthorized();

    uint256 private constant HIGH_MINT_THRESHOLD = 100_000 ether;

    IwXTMController private immutable controller;

    constructor(address _lzEndpoint, address _controller) OFTUpgradeable(_lzEndpoint) {
        _disableInitializers();
        controller = IwXTMController(_controller);
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
    }

    /** @dev Mint can only be called by multi-sig-wallets with access control */
    function mint(address _to, uint256 _amount) external {
        if (_amount > HIGH_MINT_THRESHOLD) {
            if (!controller.hasRole(controller.HIGH_MINTER_ROLE(), msg.sender)) revert Unauthorized();
        } else if (
            !controller.hasRole(controller.LOW_MINTER_ROLE(), msg.sender) &&
            !controller.hasRole(controller.HIGH_MINTER_ROLE(), msg.sender)
        ) {
            revert Unauthorized();
        }

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
