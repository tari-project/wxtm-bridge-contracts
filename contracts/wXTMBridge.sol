// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { EIP3009 } from "./extensions/EIP3009.sol";
import { ERC20Burnable } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IwXTM } from "./interfaces/IwXTM.sol";

contract wXTMBridge is EIP3009, Ownable {
    address private wXTM;

    event TokensMinted(address indexed to, uint256 indexed amount, bytes32 indexed authorizationId);
    event TokensBurned(address indexed from, uint256 indexed amount, bytes32 indexed authorizationId);

    constructor(address _wXTM) Ownable(msg.sender) {
        wXTM = _wXTM;
    }

    /** @dev Function to handle wXTM upgradable concept */
    function updatewXTMAddress(address wXTMAddress) external onlyOwner {
        wXTM = wXTMAddress;
    }

    function _mintTokens(address to, uint256 amount) internal override {
        IwXTM(wXTM).mint(to, amount);

        emit TokensMinted(to, amount, keccak256(abi.encode(to, amount, block.timestamp)));
    }

    function _burnTokens(address from, uint256 amount) internal override {
        IwXTM(wXTM).burn(from, amount);

        emit TokensBurned(from, amount, keccak256(abi.encode(from, amount, block.timestamp)));
    }
}
