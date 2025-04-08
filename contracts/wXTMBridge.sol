// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IERC20 } from "@openzeppelin/contracts/interfaces/IERC20.sol";
import { IwXTM } from "./interfaces/IwXTM.sol";

contract wXTMBridge is Ownable {
    address private wXTM;

    event TokensUnwrapped(
        address indexed from,
        string tariAddress,
        uint256 indexed amount,
        bytes32 indexed authorizationId
    );

    constructor(address _wXTM, address _delegate) Ownable(_delegate) {
        wXTM = _wXTM;
    }

    function bridgeToTari(string memory tari, uint256 value) external {
        IERC20(wXTM).transferFrom(msg.sender, address(this), value);

        IwXTM(wXTM).burn(address(this), value);

        emit TokensUnwrapped(msg.sender, tari, value, keccak256(abi.encode(address(this), value, block.timestamp)));
    }

    function bridgeToTariWithAuthorization(
        string memory tari,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        IwXTM(wXTM).receiveWithAuthorization(msg.sender, address(this), value, validAfter, validBefore, nonce, v, r, s);

        IwXTM(wXTM).burn(address(this), value);

        emit TokensUnwrapped(msg.sender, tari, value, keccak256(abi.encode(msg.sender, value, block.timestamp)));
    }
}
