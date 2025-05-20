// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

// Contract imports
import { wXTMController } from "../../contracts/wXTMController.sol";

// DevTools imports
import { Test, console } from "forge-std/Test.sol";

contract wXTMControllerTest is Test {
    wXTMController private controller;

    address private admin;
    address private lowMinter;
    address private highMinter;

    uint256 private constant INITIAL_BALANCE = 100 ether;

    function setUp() public {
        admin = makeAddr("admin");
        lowMinter = makeAddr("lowMinter");
        highMinter = makeAddr("highMinter");

        deal(admin, INITIAL_BALANCE);

        vm.prank(admin);
        controller = new wXTMController();
        controller.initialize(lowMinter, highMinter, admin);
    }

    function test_can_reassign_roles() public {
        assertTrue(controller.hasRole(controller.LOW_MINTER_ROLE(), lowMinter));
        assertTrue(controller.hasRole(controller.HIGH_MINTER_ROLE(), highMinter));

        address newLowMinter = makeAddr("newLowMinter");
        address newHighMinter = makeAddr("newHighMinter");

        vm.startPrank(admin);
        controller.grantRole(controller.LOW_MINTER_ROLE(), newLowMinter);
        controller.grantRole(controller.HIGH_MINTER_ROLE(), newHighMinter);
        vm.stopPrank();

        assertTrue(controller.hasRole(controller.LOW_MINTER_ROLE(), lowMinter));
        assertTrue(controller.hasRole(controller.HIGH_MINTER_ROLE(), highMinter));
        assertTrue(controller.hasRole(controller.LOW_MINTER_ROLE(), newLowMinter));
        assertTrue(controller.hasRole(controller.HIGH_MINTER_ROLE(), newHighMinter));

        vm.startPrank(admin);
        controller.revokeRole(controller.LOW_MINTER_ROLE(), lowMinter);
        controller.revokeRole(controller.HIGH_MINTER_ROLE(), highMinter);
        vm.stopPrank();

        assertFalse(controller.hasRole(controller.LOW_MINTER_ROLE(), lowMinter));
        assertFalse(controller.hasRole(controller.HIGH_MINTER_ROLE(), highMinter));
        assertTrue(controller.hasRole(controller.LOW_MINTER_ROLE(), newLowMinter));
        assertTrue(controller.hasRole(controller.HIGH_MINTER_ROLE(), newHighMinter));
    }
}
