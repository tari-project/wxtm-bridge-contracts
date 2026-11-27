// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { ERC1967Utils } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IwXTM } from "./interfaces/IwXTM.sol";

contract wXTMBridge is AccessControlUpgradeable, PausableUpgradeable {
    using SafeERC20 for IERC20;

    error InsufficientAmount();
    error InvalidAmountPrecision();
    error InvalidTargetTariAddress();
    error NotProxyAdmin();
    error InvalidGuardian();
    error ZeroAddress();

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev Above every version already used on a deployed proxy (mainnet 1, Sepolia 101).
    uint64 private constant ACCESS_VERSION = 102;

    /// @dev Tari has 6 decimals, wXTM 18: anything below 1e12 cannot be paid out and would be burned for nothing.
    uint256 private constant TARI_UNIT = 1e12;

    /// @dev Base58 Tari address lengths, as accepted by TariAddress::from_base58
    /// (tari base_layer/common_types/src/tari_address/mod.rs): a single address (35 bytes) encodes to 45-48
    /// characters, a dual address (67 bytes plus a payment id of up to 256 bytes) to 89-443. Unlike the wTARI
    /// bridge (Ootle targets, any 1-128 bytes), the target here is always a Tari L1 address.
    uint256 private constant MIN_TARGET_TARI_ADDRESS_LENGTH = 45;
    uint256 private constant MAX_TARGET_TARI_ADDRESS_LENGTH = 443;

    // Only linear state; AccessControl and Pausable live in ERC-7201 namespaced storage, so these keep their slots.
    uint256 private nonce;
    address private wXTM;

    event TokensUnwrapped(address from, string targetTariAddress, uint256 amount, uint256 nonce);

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

    /// @notice Initializer for a new proxy. Shares ACCESS_VERSION with initializeV2, so only one of them can ever run.
    function initialize(
        address _wXTM,
        address admin,
        address guardian
    ) external onlyNewProxy reinitializer(ACCESS_VERSION) {
        wXTM = _wXTM;
        _initializeAccess(admin, guardian);
    }

    /// @notice Upgrade of an existing proxy, through ProxyAdmin.upgradeAndCall.
    function initializeV2(address admin, address guardian) external onlyProxyAdmin reinitializer(ACCESS_VERSION) {
        _initializeAccess(admin, guardian);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function bridgeToTari(string memory targetTariAddress, uint256 value) external whenNotPaused {
        _checkValue(value);
        _checkTargetTariAddress(targetTariAddress);

        IERC20(wXTM).safeTransferFrom(msg.sender, address(this), value);

        IwXTM(wXTM).burn(value);

        emit TokensUnwrapped(msg.sender, targetTariAddress, value, nonce);

        nonce++;
    }

    function bridgeToTariWithAuthorization(
        string memory targetTariAddress,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 authNonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused {
        _checkValue(value);
        _checkTargetTariAddress(targetTariAddress);

        IwXTM(wXTM).receiveWithAuthorization(
            msg.sender,
            address(this),
            value,
            validAfter,
            validBefore,
            authNonce,
            v,
            r,
            s
        );

        IwXTM(wXTM).burn(value);

        emit TokensUnwrapped(msg.sender, targetTariAddress, value, nonce);

        nonce++;
    }

    function _initializeAccess(address admin, address guardian) private {
        if (admin == address(0)) revert ZeroAddress();
        // The guardian is a Safe and pause-only, so never the admin. A key cannot qualify: an EOA has no code, and an
        // EIP-7702 delegated EOA has the code 0xef0100 || delegate. A ProxyAdmin cannot call through its proxy, so it
        // could never pause; that check only applies in initializeV2, since a new proxy runs initialize before its
        // admin is set, so fresh deploys rely on getGuardian's Safe check (utils/admin.ts).
        bytes memory code = guardian.code;
        if (code.length == 0 || bytes3(code) == 0xef0100 || guardian == admin || guardian == ERC1967Utils.getAdmin()) {
            revert InvalidGuardian();
        }
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, guardian);
    }

    function _checkValue(uint256 value) private pure {
        if (value < 1000 ether) revert InsufficientAmount();
        if (value % TARI_UNIT != 0) revert InvalidAmountPrecision();
    }

    /// @dev Length and base58 alphabet only; the checksum is validated off-chain.
    function _checkTargetTariAddress(string memory targetTariAddress) private pure {
        bytes memory b = bytes(targetTariAddress);
        if (b.length < MIN_TARGET_TARI_ADDRESS_LENGTH || b.length > MAX_TARGET_TARI_ADDRESS_LENGTH) {
            revert InvalidTargetTariAddress();
        }
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool isBase58 = (c >= "1" && c <= "9") ||
                (c >= "A" && c <= "Z" && c != "I" && c != "O") ||
                (c >= "a" && c <= "z" && c != "l");
            if (!isBase58) revert InvalidTargetTariAddress();
        }
    }
}
