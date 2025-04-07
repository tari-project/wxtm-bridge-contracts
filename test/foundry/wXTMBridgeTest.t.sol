// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { wXTM } from "../../contracts/wXTM.sol";
import { wXTMBridge } from "../../contracts/wXTMBridge.sol";

// DevTools imports
import { console } from "forge-std/Test.sol";
import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";

contract wXTMBridgeTest is TestHelperOz5 {
    uint32 private aEid = 1;
    uint32 private bEid = 2;

    wXTM private wxtm;
    wXTMBridge private bridge;

    address private multiSig;
    address private tari;
    uint256 private multiSigKey;
    uint256 private tariKey;

    uint256 private constant STARTING_BALANCE = 100 ether;

    function setUp() public virtual override {
        (multiSig, multiSigKey) = makeAddrAndKey("multiSig");
        (tari, tariKey) = makeAddrAndKey("tari");

        deal(multiSig, STARTING_BALANCE);
        deal(tari, STARTING_BALANCE);

        super.setUp();
        setUpEndpoints(2, LibraryType.UltraLightNode);

        wxtm = wXTM(
            _deployOApp(type(wXTM).creationCode, abi.encode("WrappedXTM", "WXTM", address(endpoints[aEid]), multiSig))
        );

        vm.startPrank(multiSig);
        bridge = new wXTMBridge(address(wxtm));

        wxtm.transferOwnership(address(bridge));
        vm.stopPrank();

        // config and wire the ofts
        address[] memory ofts = new address[](1);
        ofts[0] = address(wxtm);
        this.wireOApps(ofts);
    }

    function test_receive_with_authorization() public {
        uint256 value = 3 ether;
        uint256 validAfter = block.timestamp;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("mint-1");

        bytes32 structHash = keccak256(
            abi.encode(
                bridge.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                tari,
                multiSig,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", bridge.DOMAIN_SEPARATOR(), structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(tariKey, digest);

        vm.prank(multiSig);
        bridge.receiveWithAuthorization(tari, multiSig, value, validAfter, validBefore, nonce, v, r, s);

        assertEq(wxtm.balanceOf(multiSig), value);
    }

    function test_transfer_with_authorization() public {
        vm.prank(address(bridge));
        wxtm.mint(multiSig, 10 ether);

        uint256 value = 6 ether;
        uint256 validAfter = block.timestamp;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("burn-1");

        bytes32 structHash = keccak256(
            abi.encode(
                bridge.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
                multiSig,
                tari,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", bridge.DOMAIN_SEPARATOR(), structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(multiSigKey, digest);

        vm.prank(multiSig);
        bridge.transferWithAuthorization(multiSig, tari, value, validAfter, validBefore, nonce, v, r, s);

        assertEq(wxtm.balanceOf(multiSig), 4 ether);
    }
}
