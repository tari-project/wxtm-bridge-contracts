// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

import { IwXTM } from "./interfaces/IwXTM.sol";

contract wXTMController is AccessControlUpgradeable {
    error UnauthorizedToMintThisAmount();

    uint256 private constant HIGH_MINT_THRESHOLD = 100_000 ether;
    bytes32 private constant LOW_MINTER_ROLE = keccak256("LOW_MINTER_ROLE");
    bytes32 private constant HIGH_MINTER_ROLE = keccak256("HIGH_MINTER_ROLE");

    IwXTM private wxtm;

    constructor() {
        _disableInitializers();
    }

    function initialize(address _wxtm, address lowMinter, address highMinter, address admin) external initializer {
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(LOW_MINTER_ROLE, lowMinter);
        _grantRole(HIGH_MINTER_ROLE, highMinter);

        wxtm = IwXTM(_wxtm);
    }

    function mintLowAmount(address to, uint256 amount) external onlyRole(LOW_MINTER_ROLE) {
        if (amount > HIGH_MINT_THRESHOLD) revert UnauthorizedToMintThisAmount();

        wxtm.mint(to, amount);
    }

    function mintHighAmount(address to, uint256 amount) external onlyRole(HIGH_MINTER_ROLE) {
        wxtm.mint(to, amount);
    }
}
