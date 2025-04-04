// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import {EIP3009} from "./extensions/EIP3009.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

import {IwXTM} from "./interfaces/IwXTM.sol";

contract wXTMBridge is EIP3009 {
    address private immutable wXTM;

    event TokensMinted(address indexed to, uint256 indexed amount, bytes32 indexed authorizationId);
    event TokensBurned(address indexed from, uint256 indexed amount, bytes32 indexed authorizationId);

    constructor(address _wXTM, string memory version) EIP3009("wXTMBridge", version) {
        wXTM = _wXTM;
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
