// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import { IwXTM } from "./interfaces/IwXTM.sol";

contract wXTMController is AccessControlUpgradeable, PausableUpgradeable {
    error UnauthorizedToMintThisAmount();

    uint256 private constant HIGH_MINT_THRESHOLD = 100_000 ether;
    bytes32 public constant LOW_MINTER_ROLE = keccak256("LOW_MINTER_ROLE");
    bytes32 public constant HIGH_MINTER_ROLE = keccak256("HIGH_MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev Above every version already used on a deployed proxy (mainnet 1, Sepolia and Base Sepolia 11).
    uint64 private constant PAUSER_VERSION = 12;

    // Pausable lives in ERC-7201 namespaced storage, so wxtm keeps its slot.
    IwXTM private wxtm;

    constructor() {
        _disableInitializers();
    }

    /// @dev Keeps initialize off live proxies (initialized at version 1 or more) whose upgrade did not set them up.
    modifier onlyNewProxy() {
        if (_getInitializedVersion() != 0) revert InvalidInitialization();
        _;
    }

    /// @notice Initializer for a new proxy. Shares PAUSER_VERSION with initializeV2, so only one of them can ever run.
    function initialize(
        address _wxtm,
        address lowMinter,
        address highMinter,
        address admin,
        address guardian
    ) external onlyNewProxy reinitializer(PAUSER_VERSION) {
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(LOW_MINTER_ROLE, lowMinter);
        _grantRole(HIGH_MINTER_ROLE, highMinter);

        wxtm = IwXTM(_wxtm);

        _initializePauser(guardian);
    }

    /// @notice Upgrade of an existing proxy; must be called atomically through ProxyAdmin.upgradeAndCall.
    function initializeV2(address guardian) external reinitializer(PAUSER_VERSION) {
        _initializePauser(guardian);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function mintLowAmount(address to, uint256 amount) external onlyRole(LOW_MINTER_ROLE) whenNotPaused {
        if (amount > HIGH_MINT_THRESHOLD) revert UnauthorizedToMintThisAmount();

        wxtm.mint(to, amount);
    }

    function mintHighAmount(address to, uint256 amount) external onlyRole(HIGH_MINTER_ROLE) whenNotPaused {
        wxtm.mint(to, amount);
    }

    function _initializePauser(address guardian) private {
        __Pausable_init();

        _grantRole(PAUSER_ROLE, guardian);
    }
}
