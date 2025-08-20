// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { wXTM } from "../../contracts/wXTM.sol";
import { wXTMBridge } from "../../contracts/wXTMBridge.sol";
import { wXTMController } from "../../contracts/wXTMController.sol";

import { console } from "forge-std/Test.sol";
import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import { TransparentUpgradeableProxy } from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

contract wXTMBridgeTest is TestHelperOz5 {
    event TokensUnwrapped(address from, string targetTariAddress, uint256 amount, uint256 nonce);

    bytes32 private constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint32 private aEid = 1;
    uint32 private bEid = 2;

    wXTM private wxtm;
    wXTMBridge private bridge;
    wXTMController private controller;

    address private multiSig;
    uint256 private multiSigKey;
    address private user;
    uint256 private userSigKey;
    address private lowMinter;
    address private highMinter;

    uint256 private constant INITIAL_BALANCE = 100 ether;

    function setUp() public virtual override {
        (multiSig, multiSigKey) = makeAddrAndKey("multiSig");
        (user, userSigKey) = makeAddrAndKey("user");

        lowMinter = makeAddr("lowMinter");
        highMinter = makeAddr("highMinter");

        deal(multiSig, INITIAL_BALANCE);
        deal(user, INITIAL_BALANCE);

        super.setUp();
        setUpEndpoints(2, LibraryType.UltraLightNode);

        wxtm = wXTM(
            _deployContractAndProxy(
                type(wXTM).creationCode,
                abi.encode(address(endpoints[aEid])),
                abi.encodeWithSelector(wXTM.initialize.selector, "WrappedXTM", "WXTM", "1", multiSig)
            )
        );

        controller = wXTMController(
            _deployContractAndProxy(
                type(wXTMController).creationCode,
                abi.encode(),
                abi.encodeWithSelector(
                    wXTMController.initialize.selector,
                    address(wxtm),
                    lowMinter,
                    highMinter,
                    multiSig
                )
            )
        );

        bridge = wXTMBridge(
            _deployContractAndProxy(
                type(wXTMBridge).creationCode,
                abi.encode(),
                abi.encodeWithSelector(wXTMBridge.initialize.selector, address(wxtm))
            )
        );

        vm.prank(multiSig);
        wxtm.grantRole(MINTER_ROLE, address(controller));

        /** @dev Config and wire the ofts */
        address[] memory ofts = new address[](1);
        ofts[0] = address(wxtm);
        this.wireOApps(ofts);

        vm.prank(address(controller));
        wxtm.mint(user, 10_000 ether);
    }

    function test_cant_bridge_under_required_amount() public {
        uint256 value = 999 ether;
        uint256 validAfter = block.timestamp;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("unique-nonce");

        // Generate EIP712 signature
        bytes32 digest = _getDigest(user, address(bridge), value, validAfter, validBefore, nonce);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userSigKey, digest);

        vm.startPrank(user);
        wxtm.approve(address(bridge), value);

        vm.expectRevert(wXTMBridge.InsufficientAmount.selector);
        bridge.bridgeToTari("tariExampleAddress", value);

        vm.expectRevert(wXTMBridge.InsufficientAmount.selector);
        bridge.bridgeToTariWithAuthorization("tariExampleAddress", value, validAfter, validBefore, nonce, v, r, s);
        vm.stopPrank();
    }

    function test_bridge_to_tari() public {
        uint256 value = 3000 ether;

        vm.startPrank(user);
        wxtm.approve(address(bridge), value);
        vm.expectEmit(true, true, true, true, address(bridge));
        emit TokensUnwrapped(user, "tariExampleAddress", value, 0);
        bridge.bridgeToTari("tariExampleAddress", value);
        vm.stopPrank();

        assertEq(wxtm.balanceOf(address(bridge)), 0);
        assertEq(wxtm.balanceOf(user), 7000 ether);
    }

    function test_receive_with_authorization() public {
        uint256 value = 3000 ether;
        uint256 validAfter = block.timestamp;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("unique-nonce");

        // Generate EIP712 signature
        bytes32 digest = _getDigest(user, address(bridge), value, validAfter, validBefore, nonce);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userSigKey, digest);

        vm.prank(user);
        vm.expectEmit(true, true, true, true, address(bridge));
        emit TokensUnwrapped(user, "tariExampleAddress", value, 0);
        bridge.bridgeToTariWithAuthorization("tariExampleAddress", value, validAfter, validBefore, nonce, v, r, s);

        assertEq(wxtm.balanceOf(address(bridge)), 0);
        assertEq(wxtm.balanceOf(user), 7000 ether);
    }

    function test_nonce_change() public {
        uint256 validAfter = block.timestamp;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("unique-nonce");
        bytes32 secondNonce = keccak256("unique-secondNonce");
        bytes32 digest;
        uint8 v;
        bytes32 r;
        bytes32 s;

        vm.startPrank(user);
        wxtm.approve(address(bridge), 4000 ether);
        vm.expectEmit(true, true, true, true, address(bridge));
        emit TokensUnwrapped(user, "tariExampleAddress", 1000 ether, 0);
        bridge.bridgeToTari("tariExampleAddress", 1000 ether);

        digest = _getDigest(user, address(bridge), 2000 ether, validAfter, validBefore, nonce);
        (v, r, s) = vm.sign(userSigKey, digest);
        vm.expectEmit(true, true, true, true, address(bridge));
        emit TokensUnwrapped(user, "tariExampleAddress1", 2000 ether, 1);
        bridge.bridgeToTariWithAuthorization(
            "tariExampleAddress1",
            2000 ether,
            validAfter,
            validBefore,
            nonce,
            v,
            r,
            s
        );

        vm.expectEmit(true, true, true, true, address(bridge));
        emit TokensUnwrapped(user, "tariExampleAddress2", 3000 ether, 2);
        bridge.bridgeToTari("tariExampleAddress2", 3000 ether);

        digest = _getDigest(user, address(bridge), 1001.01 ether, validAfter, validBefore, secondNonce);
        (v, r, s) = vm.sign(userSigKey, digest);
        vm.expectEmit(true, true, true, true, address(bridge));
        emit TokensUnwrapped(user, "tariExampleAddress1", 1001.01 ether, 3);
        bridge.bridgeToTariWithAuthorization(
            "tariExampleAddress1",
            1001.01 ether,
            validAfter,
            validBefore,
            secondNonce,
            v,
            r,
            s
        );
        vm.stopPrank();
    }

    function _getDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(wxtm.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, validAfter, validBefore, nonce)
        );
        /** @dev Domain hardcoded to avoid exposing _domainSeparatorV4() from wXTM contract */
        bytes32 domainSeparator = 0x336abe5edc8eeaf6093e7e0267afdba268dd1492979658c9d6164b1255653dd6;

        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
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
        return address(new TransparentUpgradeableProxy(addr, multiSig, _initializeArgs));
    }
}
