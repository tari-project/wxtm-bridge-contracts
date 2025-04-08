// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { EIP3009 } from "./extensions/EIP3009.sol";
/** @dev Ownable from openzeppelin conflict -> to be resolved */
// import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IwXTM } from "./interfaces/IwXTM.sol";

contract wXTMBridge is EIP3009 {
    error wXTMBridge_NotOwner();

    address public owner;
    address private wXTM;

    event TokensMinted(address indexed to, uint256 indexed amount, bytes32 indexed authorizationId);
    event TokensBurned(address indexed from, uint256 indexed amount, bytes32 indexed authorizationId);

    constructor(address _wXTM, address _delegate) {
        wXTM = _wXTM;
        owner = _delegate;
    }

    /** @dev Function to handle wXTM upgradable concept */
    function updatewXTMAddress(address wXTMAddress) external onlyOwner {
        wXTM = wXTMAddress;
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
    ) external onlyOwner {
        _receiveWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s);

        IwXTM(wXTM).mint(to, value);

        emit TokensMinted(to, value, keccak256(abi.encode(to, value, block.timestamp)));
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
    ) external onlyOwner {
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s);

        IwXTM(wXTM).burn(from, value);

        emit TokensBurned(from, value, keccak256(abi.encode(from, value, block.timestamp)));
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert wXTMBridge_NotOwner();

        _;
    }
}
