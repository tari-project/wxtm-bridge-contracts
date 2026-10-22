// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

import { IwTARI } from "./interfaces/IwTARI.sol";

contract wTARIController is AccessControlUpgradeable {
    error UnauthorizedToMintThisAmount();
    error LowMintDailyLimitExceeded();

    event LowMintDailyLimitSet(uint256 limit);

    uint256 private constant HIGH_MINT_THRESHOLD = 100_000 ether;
    bytes32 private constant LOW_MINTER_ROLE = keccak256("LOW_MINTER_ROLE");
    bytes32 private constant HIGH_MINTER_ROLE = keccak256("HIGH_MINTER_ROLE");

    IwTARI private wtari;

    // Low-tier mints share one budget per fixed 24h window (block.timestamp / 1 days).
    uint256 public lowMintDailyLimit;
    uint256 public lowMintWindow;
    uint256 public lowMintedInWindow;

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _wtari,
        address lowMinter,
        address highMinter,
        address admin,
        uint256 _lowMintDailyLimit
    ) external initializer {
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(LOW_MINTER_ROLE, lowMinter);
        _grantRole(HIGH_MINTER_ROLE, highMinter);

        wtari = IwTARI(_wtari);

        lowMintDailyLimit = _lowMintDailyLimit;
        emit LowMintDailyLimitSet(_lowMintDailyLimit);
    }

    function setLowMintDailyLimit(uint256 limit) external onlyRole(DEFAULT_ADMIN_ROLE) {
        lowMintDailyLimit = limit;
        emit LowMintDailyLimitSet(limit);
    }

    function mintLowAmount(address to, uint256 amount) external onlyRole(LOW_MINTER_ROLE) {
        if (amount > HIGH_MINT_THRESHOLD) revert UnauthorizedToMintThisAmount();

        uint256 window = block.timestamp / 1 days;
        if (window != lowMintWindow) {
            lowMintWindow = window;
            lowMintedInWindow = 0;
        }
        if (lowMintedInWindow + amount > lowMintDailyLimit) revert LowMintDailyLimitExceeded();
        lowMintedInWindow += amount;

        wtari.mint(to, amount);
    }

    function mintHighAmount(address to, uint256 amount) external onlyRole(HIGH_MINTER_ROLE) {
        wtari.mint(to, amount);
    }
}
