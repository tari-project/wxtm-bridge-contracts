// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

contract wXTMController is AccessControlUpgradeable {
    bytes32 public constant LOW_MINTER_ROLE = keccak256("LOW_MINTER_ROLE");
    bytes32 public constant HIGH_MINTER_ROLE = keccak256("HIGH_MINTER_ROLE");

    function initialize(address lowMinter, address highMinter, address admin) external initializer {
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        _grantRole(LOW_MINTER_ROLE, lowMinter);
        _grantRole(HIGH_MINTER_ROLE, highMinter);
    }
}
