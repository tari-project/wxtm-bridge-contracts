// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { ERC1967Utils } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import { IwXTM } from "./interfaces/IwXTM.sol";

contract wXTMController is AccessControlUpgradeable, PausableUpgradeable {
    error UnauthorizedToMintThisAmount();
    error NotProxyAdmin();
    error InvalidGuardian();
    error ZeroAddress();

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

    /// @dev The upgrade setup can only come from the proxy's ProxyAdmin, i.e. through ProxyAdmin.upgradeAndCall.
    /// After a plain upgrade() nobody else can call it; the admin finishes with upgradeAndCall to the same
    /// implementation.
    modifier onlyProxyAdmin() {
        if (msg.sender != ERC1967Utils.getAdmin()) revert NotProxyAdmin();
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
        if (admin == address(0)) revert ZeroAddress();
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(LOW_MINTER_ROLE, lowMinter);
        _grantRole(HIGH_MINTER_ROLE, highMinter);

        wxtm = IwXTM(_wxtm);

        _initializePauser(guardian);
    }

    /// @notice Upgrade of an existing proxy, through ProxyAdmin.upgradeAndCall.
    function initializeV2(address guardian) external onlyProxyAdmin reinitializer(PAUSER_VERSION) {
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
        // The guardian is a Safe and pause-only, so never the admin or a minter. A key cannot qualify: an EOA has no
        // code, and an EIP-7702 delegated EOA has the code 0xef0100 || delegate. A ProxyAdmin cannot call through its
        // proxy, so it could never pause; that check only applies in initializeV2, since a new proxy runs initialize
        // before its admin is set, so fresh deploys rely on getGuardian's Safe check (utils/admin.ts).
        bytes memory code = guardian.code;
        if (
            code.length == 0 ||
            bytes3(code) == 0xef0100 ||
            hasRole(DEFAULT_ADMIN_ROLE, guardian) ||
            hasRole(LOW_MINTER_ROLE, guardian) ||
            hasRole(HIGH_MINTER_ROLE, guardian) ||
            guardian == ERC1967Utils.getAdmin()
        ) revert InvalidGuardian();
        __Pausable_init();

        _grantRole(PAUSER_ROLE, guardian);
    }
}
