// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

// Contract imports
import { wXTM } from "../../contracts/wXTM.sol";
import { wXTMController } from "../../contracts/wXTMController.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

// DevTools imports
import { console } from "forge-std/Test.sol";
import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import { TransparentUpgradeableProxy } from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

contract wXTMControllerTest is TestHelperOz5 {
    bytes32 private constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 private constant LOW_MINTER_ROLE = keccak256("LOW_MINTER_ROLE");
    bytes32 private constant HIGH_MINTER_ROLE = keccak256("HIGH_MINTER_ROLE");

    uint32 private aEid = 1;
    uint32 private bEid = 2;

    wXTM private wxtm;
    wXTMController private controller;

    address private admin;
    address private lowMinter;
    address private highMinter;
    address private user;

    uint256 private constant INITIAL_BALANCE = 100 ether;

    function setUp() public virtual override {
        admin = makeAddr("admin");
        lowMinter = makeAddr("lowMinter");
        highMinter = makeAddr("highMinter");
        user = makeAddr("user");

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
        controller = new wXTMController();
        controller.initialize(address(wxtm), lowMinter, highMinter, admin);

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
