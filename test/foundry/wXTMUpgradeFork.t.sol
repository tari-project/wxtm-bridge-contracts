// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import { wXTMBridge } from "../../contracts/wXTMBridge.sol";
import { wXTMController } from "../../contracts/wXTMController.sol";

interface IProxyAdmin {
    function upgradeAndCall(address proxy, address implementation, bytes calldata data) external payable;
}

/// @dev Upgrades the mainnet wXTMBridge and wXTMController proxies on a fork of MAINNET_RPC_URL (the variable
/// hardhat.config.ts uses); skipped when it is not set.
contract wXTMUpgradeForkTest is Test {
    address private constant WXTM = 0xfD36fA88bb3feA8D1264fc89d70723b6a2B56958;
    address private constant BRIDGE = 0x810be828EFA687667B289C488A57a7B48Fb4523E;
    address private constant CONTROLLER = 0x6c6f5B091bc50a6cB62e55B5c1EB7455205d2880;
    address private constant ADMIN = 0xe178b64Acf345A48a5a9FD34CA4F8d9cbA864fCB;
    address private constant LOW_MINTER = 0x7cC835597EADFa3C5A5d9f0B90c0491C289B8Eee;
    address private constant HIGH_MINTER = 0xFa2459708A9549C371963a3fCd239dd614E8D52C;

    bytes32 private constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 private constant LOW_MINTER_ROLE = keccak256("LOW_MINTER_ROLE");
    bytes32 private constant HIGH_MINTER_ROLE = keccak256("HIGH_MINTER_ROLE");
    bytes32 private constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 private constant EIP1967_ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    string private constant TARI_ADDRESS =
        "f2EUfFdG7hNyXXDNkuBefP74UPJZtWQ9VN2ZjLfP7vRyutrwNYU74gN8Uv3xqpsgxMzppKS4zzZuzBDMDxDX6AUXjxS";

    wXTMBridge private bridge = wXTMBridge(BRIDGE);
    wXTMController private controller = wXTMController(CONTROLLER);
    address private guardian = makeAddr("guardian");
    address private user = makeAddr("user");

    uint256 private nonceBefore;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "MAINNET_RPC_URL not set");
            return;
        }
        vm.createSelectFork(rpc);

        // Bridge storage: slot 0 nonce, slot 1 wXTM.
        nonceBefore = uint256(vm.load(BRIDGE, bytes32(uint256(0))));
        assertGe(nonceBefore, 157, "nonce at audit time was 157");
        assertEq(_wxtmOf(BRIDGE), WXTM);
        _assertControllerRolesUnchanged();

        _upgrade(BRIDGE, address(new wXTMBridge()), abi.encodeCall(wXTMBridge.initializeV2, (ADMIN, guardian)));
        _upgrade(CONTROLLER, address(new wXTMController()), abi.encodeCall(wXTMController.initializeV2, (guardian)));
    }

    function test_upgrade_preserves_state_and_roles() public view {
        assertEq(uint256(vm.load(BRIDGE, bytes32(uint256(0)))), nonceBefore);
        assertEq(_wxtmOf(BRIDGE), WXTM);
        _assertControllerRolesUnchanged();

        assertTrue(bridge.hasRole(bridge.DEFAULT_ADMIN_ROLE(), ADMIN));
        assertTrue(bridge.hasRole(PAUSER_ROLE, guardian));
        assertTrue(controller.hasRole(PAUSER_ROLE, guardian));
        assertFalse(bridge.paused());
        assertFalse(controller.paused());
    }

    function test_initializers_closed_after_upgrade() public {
        vm.startPrank(user);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        bridge.initialize(user, user, user);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        bridge.initializeV2(user, user);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        controller.initialize(WXTM, user, user, user, user);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        controller.initializeV2(user);
        vm.stopPrank();
    }

    function test_mint_and_unwrap_still_work() public {
        vm.prank(LOW_MINTER);
        controller.mintLowAmount(user, 1000 ether);
        vm.prank(HIGH_MINTER);
        controller.mintHighAmount(user, 1000 ether);

        uint256 supplyBefore = IERC20(WXTM).totalSupply();
        vm.startPrank(user);
        IERC20(WXTM).approve(BRIDGE, 2000 ether);
        vm.expectEmit(BRIDGE);
        emit wXTMBridge.TokensUnwrapped(user, TARI_ADDRESS, 2000 ether, nonceBefore);
        bridge.bridgeToTari(TARI_ADDRESS, 2000 ether);
        vm.stopPrank();

        assertEq(IERC20(WXTM).totalSupply(), supplyBefore - 2000 ether);
        assertEq(uint256(vm.load(BRIDGE, bytes32(uint256(0)))), nonceBefore + 1);
    }

    function test_pause_blocks_unwrap_and_mint() public {
        vm.prank(LOW_MINTER);
        controller.mintLowAmount(user, 1000 ether);

        vm.startPrank(guardian);
        bridge.pause();
        controller.pause();
        vm.stopPrank();

        vm.startPrank(user);
        IERC20(WXTM).approve(BRIDGE, 1000 ether);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridge.bridgeToTari(TARI_ADDRESS, 1000 ether);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridge.bridgeToTariWithAuthorization(TARI_ADDRESS, 1000 ether, 0, type(uint256).max, 0, 0, 0, 0);
        vm.stopPrank();

        vm.prank(LOW_MINTER);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        controller.mintLowAmount(user, 1000 ether);
        vm.prank(HIGH_MINTER);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        controller.mintHighAmount(user, 1000 ether);
    }

    function test_non_guardian_cannot_pause_and_guardian_cannot_unpause() public {
        for (uint256 i = 0; i < 2; i++) {
            PausableTarget target = i == 0 ? PausableTarget(BRIDGE) : PausableTarget(CONTROLLER);

            vm.prank(user);
            vm.expectRevert(
                abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, user, PAUSER_ROLE)
            );
            target.pause();

            vm.prank(guardian);
            target.pause();

            vm.prank(guardian);
            vm.expectRevert(
                abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, bytes32(0))
            );
            target.unpause();

            vm.prank(ADMIN);
            target.unpause();
        }
    }

    function _upgrade(address proxy, address implementation, bytes memory data) private {
        address proxyAdmin = address(uint160(uint256(vm.load(proxy, EIP1967_ADMIN_SLOT))));
        vm.prank(ADMIN);
        IProxyAdmin(proxyAdmin).upgradeAndCall(proxy, implementation, data);
    }

    function _wxtmOf(address proxy) private view returns (address) {
        return address(uint160(uint256(vm.load(proxy, bytes32(uint256(1))))));
    }

    function _assertControllerRolesUnchanged() private view {
        assertTrue(controller.hasRole(bytes32(0), ADMIN));
        assertTrue(controller.hasRole(LOW_MINTER_ROLE, LOW_MINTER));
        assertTrue(controller.hasRole(HIGH_MINTER_ROLE, HIGH_MINTER));
        assertTrue(IAccessControl(WXTM).hasRole(MINTER_ROLE, CONTROLLER));
        // wxtm is slot 0 of the controller.
        assertEq(address(uint160(uint256(vm.load(CONTROLLER, bytes32(0))))), WXTM);
    }
}

interface PausableTarget {
    function pause() external;

    function unpause() external;
}
