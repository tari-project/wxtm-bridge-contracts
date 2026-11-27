// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// Contract imports
import { wXTM } from "../../contracts/wXTM.sol";
import { wXTMController } from "../../contracts/wXTMController.sol";
import { ProxyAdmin } from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import { ITransparentUpgradeableProxy } from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

// DevTools imports
import { console } from "forge-std/Test.sol";
import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import { TransparentUpgradeableProxy } from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

contract wXTMControllerTest is TestHelperOz5 {
    bytes32 private constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 private constant LOW_MINTER_ROLE = keccak256("LOW_MINTER_ROLE");
    bytes32 private constant HIGH_MINTER_ROLE = keccak256("HIGH_MINTER_ROLE");
    bytes32 private constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    // OpenZeppelin Initializable's ERC-7201 slot; its low 8 bytes hold the initialized version.
    bytes32 private constant ERC1967_ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    bytes32 private constant INITIALIZABLE_SLOT = 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;

    uint32 private aEid = 1;
    uint32 private bEid = 2;

    wXTM private wxtm;
    wXTMController private controller;

    address private admin;
    address private lowMinter;
    address private highMinter;
    address private user;
    address private guardian;

    uint256 private constant INITIAL_BALANCE = 100 ether;

    function setUp() public virtual override {
        admin = makeAddr("admin");
        lowMinter = makeAddr("lowMinter");
        highMinter = makeAddr("highMinter");
        user = makeAddr("user");
        guardian = makeAddr("guardian");
        vm.etch(guardian, hex"00"); // stands in for the guardian Safe: the contracts require code there

        deal(admin, INITIAL_BALANCE);

        super.setUp();
        setUpEndpoints(2, LibraryType.UltraLightNode);

        wxtm = wXTM(
            _deployContractAndProxy(
                type(wXTM).creationCode,
                abi.encode(address(endpoints[aEid])),
                abi.encodeWithSelector(wXTM.initialize.selector, "WrappedXTM", "WXTM", "1", admin)
            )
        );

        vm.startPrank(admin);
        controller = wXTMController(
            _deployContractAndProxy(
                type(wXTMController).creationCode,
                abi.encode(),
                abi.encodeWithSelector(
                    wXTMController.initialize.selector,
                    address(wxtm),
                    lowMinter,
                    highMinter,
                    admin,
                    guardian
                )
            )
        );

        wxtm.grantRole(MINTER_ROLE, address(controller));
        vm.stopPrank();

        // config and wire the ofts
        address[] memory ofts = new address[](1);
        ofts[0] = address(wxtm);
        this.wireOApps(ofts);
    }

    function test_unauthorized_cannot_mint() public {
        vm.prank(address(666));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                address(666),
                LOW_MINTER_ROLE
            )
        );
        controller.mintLowAmount(user, INITIAL_BALANCE);

        vm.prank(address(777));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                address(777),
                HIGH_MINTER_ROLE
            )
        );
        controller.mintHighAmount(user, INITIAL_BALANCE);
    }

    function test_authorized_can_mint_only_proper_amount() public {
        vm.prank(lowMinter);
        vm.expectRevert(wXTMController.UnauthorizedToMintThisAmount.selector);
        controller.mintLowAmount(user, 100_001 ether);

        vm.prank(lowMinter);
        controller.mintLowAmount(user, 5);

        vm.startPrank(highMinter);
        controller.mintHighAmount(user, 5);
        controller.mintHighAmount(user, 200_000 ether);
        vm.stopPrank();
    }

    function test_can_reassign_roles() public {
        assertTrue(controller.hasRole(LOW_MINTER_ROLE, lowMinter));
        assertTrue(controller.hasRole(HIGH_MINTER_ROLE, highMinter));

        address newLowMinter = makeAddr("newLowMinter");
        address newHighMinter = makeAddr("newHighMinter");

        vm.startPrank(admin);
        controller.grantRole(LOW_MINTER_ROLE, newLowMinter);
        controller.grantRole(HIGH_MINTER_ROLE, newHighMinter);
        vm.stopPrank();

        assertTrue(controller.hasRole(LOW_MINTER_ROLE, lowMinter));
        assertTrue(controller.hasRole(HIGH_MINTER_ROLE, highMinter));
        assertTrue(controller.hasRole(LOW_MINTER_ROLE, newLowMinter));
        assertTrue(controller.hasRole(HIGH_MINTER_ROLE, newHighMinter));

        vm.startPrank(admin);
        controller.revokeRole(LOW_MINTER_ROLE, lowMinter);
        controller.revokeRole(HIGH_MINTER_ROLE, highMinter);
        vm.stopPrank();

        assertFalse(controller.hasRole(LOW_MINTER_ROLE, lowMinter));
        assertFalse(controller.hasRole(HIGH_MINTER_ROLE, highMinter));
        assertTrue(controller.hasRole(LOW_MINTER_ROLE, newLowMinter));
        assertTrue(controller.hasRole(HIGH_MINTER_ROLE, newHighMinter));
    }

    function test_role_getters_match_interface() public view {
        assertEq(controller.LOW_MINTER_ROLE(), LOW_MINTER_ROLE);
        assertEq(controller.HIGH_MINTER_ROLE(), HIGH_MINTER_ROLE);
        assertEq(controller.PAUSER_ROLE(), PAUSER_ROLE);
    }

    function test_paused_controller_rejects_both_mints() public {
        vm.prank(guardian);
        controller.pause();

        vm.prank(lowMinter);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        controller.mintLowAmount(user, 5);

        vm.prank(highMinter);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        controller.mintHighAmount(user, 5);

        vm.prank(admin);
        controller.unpause();

        vm.prank(lowMinter);
        controller.mintLowAmount(user, 5);
        vm.prank(highMinter);
        controller.mintHighAmount(user, 5);
        assertEq(wxtm.balanceOf(user), 10);
    }

    function test_only_guardian_pauses_only_admin_unpauses() public {
        assertTrue(controller.hasRole(PAUSER_ROLE, guardian));

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, PAUSER_ROLE)
        );
        controller.pause();

        vm.prank(guardian);
        controller.pause();

        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, bytes32(0))
        );
        controller.unpause();

        vm.prank(admin);
        controller.unpause();
        assertFalse(controller.paused());
    }

    function test_setup_rejected_on_live_proxy_upgraded_without_setup() public {
        // A live proxy initialized at version 1 by the old `initializer`, upgraded without a setup call.
        address implementation = address(new wXTMController());
        wXTMController live = wXTMController(address(new TransparentUpgradeableProxy(implementation, admin, "")));
        vm.store(address(live), INITIALIZABLE_SLOT, bytes32(uint256(1)));

        vm.startPrank(user);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        live.initialize(address(wxtm), user, user, user, user);
        vm.expectRevert(wXTMController.NotProxyAdmin.selector);
        live.initializeV2(user);
        vm.stopPrank();

        // The admin finishes with upgradeAndCall to the same implementation.
        vm.prank(admin);
        _proxyAdmin(address(live)).upgradeAndCall(
            ITransparentUpgradeableProxy(address(live)),
            implementation,
            abi.encodeCall(wXTMController.initializeV2, (guardian))
        );
        assertTrue(live.hasRole(PAUSER_ROLE, guardian));
    }

    function test_initializers_run_once() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        controller.initialize(address(wxtm), user, user, user, user);

        vm.expectRevert(wXTMController.NotProxyAdmin.selector);
        controller.initializeV2(user);

        address implementation = address(new wXTMController());
        bytes memory setup = abi.encodeCall(wXTMController.initializeV2, (user));
        ProxyAdmin proxyAdmin = _proxyAdmin(address(controller));
        vm.prank(admin);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        proxyAdmin.upgradeAndCall(ITransparentUpgradeableProxy(address(controller)), implementation, setup);
    }

    function test_rejects_proxy_admin_or_minter_as_guardian() public {
        for (uint256 i = 0; i < 3; i++) {
            wXTMController fresh = wXTMController(
                address(new TransparentUpgradeableProxy(address(new wXTMController()), admin, ""))
            );
            address proxyAdmin = address(_proxyAdmin(address(fresh)));
            // [low minter, high minter, guardian]: the ProxyAdmin as guardian, then the guardian as either minter.
            address[3][3] memory cases = [
                [lowMinter, highMinter, proxyAdmin],
                [guardian, highMinter, guardian],
                [lowMinter, guardian, guardian]
            ];
            vm.expectRevert(wXTMController.InvalidGuardian.selector);
            fresh.initialize(address(wxtm), cases[i][0], cases[i][1], admin, cases[i][2]);
        }
    }

    function test_rejects_zero_admin_or_invalid_guardian() public {
        address eoa = makeAddr("eoa");
        address delegated = makeAddr("delegated");
        vm.etch(delegated, abi.encodePacked(hex"ef0100", address(wxtm))); // EIP-7702 delegated EOA
        // [admin, guardian]: zero admin; zero, EOA, delegated EOA, or admin-as-guardian.
        address[2][5] memory cases = [
            [address(0), guardian],
            [admin, address(0)],
            [admin, eoa],
            [admin, delegated],
            [guardian, guardian]
        ];
        bytes4[5] memory errors = [
            wXTMController.ZeroAddress.selector,
            wXTMController.InvalidGuardian.selector,
            wXTMController.InvalidGuardian.selector,
            wXTMController.InvalidGuardian.selector,
            wXTMController.InvalidGuardian.selector
        ];
        for (uint256 i = 0; i < cases.length; i++) {
            wXTMController fresh = wXTMController(
                address(new TransparentUpgradeableProxy(address(new wXTMController()), admin, ""))
            );
            vm.expectRevert(errors[i]);
            fresh.initialize(address(wxtm), lowMinter, highMinter, cases[i][0], cases[i][1]);
        }
    }

    function _proxyAdmin(address proxy) internal view returns (ProxyAdmin) {
        return ProxyAdmin(address(uint160(uint256(vm.load(proxy, ERC1967_ADMIN_SLOT)))));
    }

    /** @dev It can be taken from OFTTest -> import { OFTTest } from "@layerzerolabs/oft-evm-upgradeable/test/OFT.t.sol"; */
    // but this import overrides a lot of variables, so its simpler to stick with below function only
    function _deployContractAndProxy(
        bytes memory _oappBytecode,
        bytes memory _constructorArgs,
        bytes memory _initializeArgs
    ) internal returns (address addr) {
        bytes memory bytecode = bytes.concat(abi.encodePacked(_oappBytecode), _constructorArgs);
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
            if iszero(extcodesize(addr)) {
                revert(0, 0)
            }
        }

        // proxyAdmin = multiSig
        return address(new TransparentUpgradeableProxy(addr, admin, _initializeArgs));
    }
}
