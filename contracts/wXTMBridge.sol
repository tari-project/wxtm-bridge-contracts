// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IwXTM } from "./interfaces/IwXTM.sol";

contract wXTMBridge {
    using SafeERC20 for IERC20;

    address private immutable wXTM;

    event TokensUnwrapped(address indexed from, string targetTariAddress, uint256 indexed amount);

    constructor(address _wXTM) {
        wXTM = _wXTM;
    }

    function bridgeToTari(string memory targetTariAddress, uint256 value) external {
        IERC20(wXTM).safeTransferFrom(msg.sender, address(this), value);

        IwXTM(wXTM).burn(value);

        emit TokensUnwrapped(msg.sender, targetTariAddress, value);
    }

    function bridgeToTariWithAuthorization(
        string memory targetTariAddress,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        IwXTM(wXTM).receiveWithAuthorization(msg.sender, address(this), value, validAfter, validBefore, nonce, v, r, s);

        IwXTM(wXTM).burn(value);

        emit TokensUnwrapped(msg.sender, targetTariAddress, value);
    }
}
