// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { wXTM } from "../../contracts/wXTM.sol";
import { wXTMBridge } from "../../contracts/wXTMBridge.sol";
import { wXTMController } from "../../contracts/wXTMController.sol";

import { console } from "forge-std/Test.sol";
import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import { TransparentUpgradeableProxy } from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

contract wXTMBridgeTest is TestHelperOz5 {
    event TokensUnwrapped(address from, string targetTariAddress, uint256 amount, uint256 nonce);

    bytes32 private constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 private constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // Dual Tari address (91 characters).
    string private constant TARI_ADDRESS =
        "f2EUfFdG7hNyXXDNkuBefP74UPJZtWQ9VN2ZjLfP7vRyutrwNYU74gN8Uv3xqpsgxMzppKS4zzZuzBDMDxDX6AUXjxS";
    string private constant BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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
    address private guardian;

    uint256 private constant INITIAL_BALANCE = 100 ether;

    function setUp() public virtual override {
        (multiSig, multiSigKey) = makeAddrAndKey("multiSig");
        (user, userSigKey) = makeAddrAndKey("user");

        lowMinter = makeAddr("lowMinter");
        highMinter = makeAddr("highMinter");
        guardian = makeAddr("guardian");

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
                    multiSig,
                    guardian
                )
            )
        );

        bridge = wXTMBridge(
            _deployContractAndProxy(
                type(wXTMBridge).creationCode,
                abi.encode(),
                abi.encodeWithSelector(wXTMBridge.initialize.selector, address(wxtm), multiSig, guardian)
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
        bridge.bridgeToTari(TARI_ADDRESS, value);

        vm.expectRevert(wXTMBridge.InsufficientAmount.selector);
        bridge.bridgeToTariWithAuthorization(TARI_ADDRESS, value, validAfter, validBefore, nonce, v, r, s);
        vm.stopPrank();
    }

    function test_bridge_to_tari() public {
        uint256 value = 3000 ether;

        vm.startPrank(user);
        wxtm.approve(address(bridge), value);
        vm.expectEmit(true, true, true, true, address(bridge));
        emit TokensUnwrapped(user, TARI_ADDRESS, value, 0);
        bridge.bridgeToTari(TARI_ADDRESS, value);
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
        emit TokensUnwrapped(user, TARI_ADDRESS, value, 0);
        bridge.bridgeToTariWithAuthorization(TARI_ADDRESS, value, validAfter, validBefore, nonce, v, r, s);

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
        emit TokensUnwrapped(user, TARI_ADDRESS, 1000 ether, 0);
        bridge.bridgeToTari(TARI_ADDRESS, 1000 ether);

        digest = _getDigest(user, address(bridge), 2000 ether, validAfter, validBefore, nonce);
        (v, r, s) = vm.sign(userSigKey, digest);
        vm.expectEmit(true, true, true, true, address(bridge));
        emit TokensUnwrapped(user, string.concat(TARI_ADDRESS, "1"), 2000 ether, 1);
        bridge.bridgeToTariWithAuthorization(
            string.concat(TARI_ADDRESS, "1"),
            2000 ether,
            validAfter,
            validBefore,
            nonce,
            v,
            r,
            s
        );

        vm.expectEmit(true, true, true, true, address(bridge));
        emit TokensUnwrapped(user, string.concat(TARI_ADDRESS, "2"), 3000 ether, 2);
        bridge.bridgeToTari(string.concat(TARI_ADDRESS, "2"), 3000 ether);

        digest = _getDigest(user, address(bridge), 1001.01 ether, validAfter, validBefore, secondNonce);
        (v, r, s) = vm.sign(userSigKey, digest);
        vm.expectEmit(true, true, true, true, address(bridge));
        emit TokensUnwrapped(user, string.concat(TARI_ADDRESS, "1"), 1001.01 ether, 3);
        bridge.bridgeToTariWithAuthorization(
            string.concat(TARI_ADDRESS, "1"),
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

    function test_rejects_amount_below_tari_precision() public {
        uint256 value = 1000 ether + 1;

        vm.startPrank(user);
        wxtm.approve(address(bridge), type(uint256).max);
        vm.expectRevert(wXTMBridge.InvalidAmountPrecision.selector);
        bridge.bridgeToTari(TARI_ADDRESS, value);

        vm.expectRevert(wXTMBridge.InvalidAmountPrecision.selector);
        bridge.bridgeToTari(TARI_ADDRESS, 1000 ether + 1e12 - 1);

        (uint8 v, bytes32 r, bytes32 s) = _signAuthorization(value, keccak256("dust"));
        vm.expectRevert(wXTMBridge.InvalidAmountPrecision.selector);
        bridge.bridgeToTariWithAuthorization(
            TARI_ADDRESS,
            value,
            block.timestamp,
            block.timestamp + 1 hours,
            keccak256("dust"),
            v,
            r,
            s
        );
        vm.stopPrank();

        // One micro-Tari above the minimum is fine.
        vm.prank(user);
        bridge.bridgeToTari(TARI_ADDRESS, 1000 ether + 1e12);
    }

    function test_rejects_invalid_target_tari_address() public {
        string[] memory invalid = new string[](10);
        invalid[0] = "";
        invalid[1] = _base58(44); // shorter than a single address
        invalid[2] = _base58(444); // longer than a dual address with the largest payment id
        invalid[3] = _withByteAt(TARI_ADDRESS, 10, unicode"🦄");
        invalid[4] = _withByteAt(TARI_ADDRESS, 10, "\x00");
        invalid[5] = _withByteAt(TARI_ADDRESS, 10, " ");
        invalid[6] = _withByteAt(TARI_ADDRESS, 10, "0");
        invalid[7] = _withByteAt(TARI_ADDRESS, 10, "O");
        invalid[8] = _withByteAt(TARI_ADDRESS, 10, "I");
        invalid[9] = _withByteAt(TARI_ADDRESS, 10, "l");

        vm.startPrank(user);
        wxtm.approve(address(bridge), type(uint256).max);
        for (uint256 i = 0; i < invalid.length; i++) {
            vm.expectRevert(wXTMBridge.InvalidTargetTariAddress.selector);
            bridge.bridgeToTari(invalid[i], 1000 ether);

            bytes32 authNonce = keccak256(abi.encode("invalid", i));
            (uint8 v, bytes32 r, bytes32 s) = _signAuthorization(1000 ether, authNonce);
            vm.expectRevert(wXTMBridge.InvalidTargetTariAddress.selector);
            bridge.bridgeToTariWithAuthorization(
                invalid[i],
                1000 ether,
                block.timestamp,
                block.timestamp + 1 hours,
                authNonce,
                v,
                r,
                s
            );
        }
        vm.stopPrank();
    }

    function test_accepts_every_supported_tari_address_length() public {
        // Single address: 45-48 characters; dual address: 89-443 (payment id up to 256 bytes).
        uint256[6] memory lengths = [uint256(45), 48, 89, 91, 200, 443];

        vm.prank(address(controller));
        wxtm.mint(user, lengths.length * 1000 ether);

        vm.startPrank(user);
        wxtm.approve(address(bridge), type(uint256).max);
        for (uint256 i = 0; i < lengths.length; i++) {
            bridge.bridgeToTari(_base58(lengths[i]), 1000 ether);
        }
        vm.stopPrank();

        // Every base58 character is accepted.
        vm.prank(user);
        bridge.bridgeToTari(BASE58_ALPHABET, 1000 ether);
    }

    function test_paused_bridge_rejects_both_entry_points() public {
        vm.prank(guardian);
        bridge.pause();

        (uint8 v, bytes32 r, bytes32 s) = _signAuthorization(1000 ether, keccak256("paused"));

        vm.startPrank(user);
        wxtm.approve(address(bridge), 1000 ether);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridge.bridgeToTari(TARI_ADDRESS, 1000 ether);

        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridge.bridgeToTariWithAuthorization(
            TARI_ADDRESS,
            1000 ether,
            block.timestamp,
            block.timestamp + 1 hours,
            keccak256("paused"),
            v,
            r,
            s
        );
        vm.stopPrank();

        vm.prank(multiSig);
        bridge.unpause();

        vm.prank(user);
        bridge.bridgeToTari(TARI_ADDRESS, 1000 ether);
    }

    function test_only_guardian_pauses_only_admin_unpauses() public {
        assertTrue(bridge.hasRole(bridge.DEFAULT_ADMIN_ROLE(), multiSig));
        assertTrue(bridge.hasRole(PAUSER_ROLE, guardian));

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, user, PAUSER_ROLE)
        );
        bridge.pause();

        vm.prank(guardian);
        bridge.pause();
        assertTrue(bridge.paused());

        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, bytes32(0))
        );
        bridge.unpause();

        vm.prank(multiSig);
        bridge.unpause();
        assertFalse(bridge.paused());
    }

    function test_initializers_run_once() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        bridge.initializeV2(user, user);

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        bridge.initialize(address(wxtm), user, user);
    }

    function _signAuthorization(uint256 value, bytes32 authNonce) internal view returns (uint8, bytes32, bytes32) {
        bytes32 digest = _getDigest(
            user,
            address(bridge),
            value,
            block.timestamp,
            block.timestamp + 1 hours,
            authNonce
        );
        return vm.sign(userSigKey, digest);
    }

    function _base58(uint256 length) internal pure returns (string memory) {
        bytes memory alphabet = bytes(BASE58_ALPHABET);
        bytes memory out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = alphabet[i % alphabet.length];
        }
        return string(out);
    }

    function _withByteAt(string memory s, uint256 index, string memory insert) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory head = new bytes(index);
        bytes memory tail = new bytes(b.length - index - 1);
        for (uint256 i = 0; i < index; i++) head[i] = b[i];
        for (uint256 i = 0; i < tail.length; i++) tail[i] = b[index + 1 + i];
        return string.concat(string(head), insert, string(tail));
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
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("WXTM"),
                keccak256("1"),
                block.chainid,
                address(wxtm)
            )
        );

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
