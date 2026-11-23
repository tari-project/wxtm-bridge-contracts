// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { wTARI } from "../../contracts/wTARI.sol";
import { wTARIBridge } from "../../contracts/wTARIBridge.sol";
import { wTARIController } from "../../contracts/wTARIController.sol";
import { SafeMock } from "../mocks/SafeMock.sol";

import { EIP3009 } from "../../contracts/extensions/EIP3009.sol";
import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { TransparentUpgradeableProxy } from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

contract wTARITest is TestHelperOz5 {
    event TokensUnwrapped(address from, string targetTariAddress, uint256 amount, uint256 nonce);

    bytes32 private constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 private constant LOW_MINTER_ROLE = keccak256("LOW_MINTER_ROLE");
    bytes32 private constant HIGH_MINTER_ROLE = keccak256("HIGH_MINTER_ROLE");
    string private constant OOTLE_ADDRESS =
        "otl_esm_1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7v9kn6";

    uint32 private aEid = 1;
    uint256 private constant LOW_MINT_DAILY_LIMIT = 250_000 ether;
    address private constant SAFE_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;

    wTARI private token;
    wTARIBridge private bridge;
    wTARIController private controller;
    SafeMock private lowSafe;
    SafeMock private highSafe;

    address private admin;
    address private safeOwner;
    address private user;
    uint256 private userKey;

    function setUp() public virtual override {
        admin = makeAddr("admin");
        safeOwner = makeAddr("safeOwner");
        (user, userKey) = makeAddrAndKey("user");

        address[] memory owners = new address[](1);
        owners[0] = safeOwner;
        lowSafe = new SafeMock(SAFE_SINGLETON, owners, 1);
        highSafe = new SafeMock(SAFE_SINGLETON, owners, 1);

        super.setUp();
        setUpEndpoints(1, LibraryType.UltraLightNode);

        token = wTARI(
            _deployContractAndProxy(
                type(wTARI).creationCode,
                abi.encode(address(endpoints[aEid])),
                abi.encodeWithSelector(wTARI.initialize.selector, "WrappedTARI", "wTARI", "1", admin)
            )
        );
        controller = wTARIController(
            _deployContractAndProxy(
                type(wTARIController).creationCode,
                abi.encode(),
                abi.encodeWithSelector(
                    wTARIController.initialize.selector,
                    address(token),
                    address(lowSafe),
                    address(highSafe),
                    admin,
                    LOW_MINT_DAILY_LIMIT
                )
            )
        );
        bridge = wTARIBridge(
            _deployContractAndProxy(
                type(wTARIBridge).creationCode,
                abi.encode(),
                abi.encodeWithSelector(wTARIBridge.initialize.selector, address(token))
            )
        );

        vm.prank(admin);
        token.grantRole(MINTER_ROLE, address(controller));
    }

    function test_metadata() public view {
        assertEq(token.symbol(), "wTARI");
        assertEq(token.decimals(), 18);
    }

    function test_initializers_cannot_be_rerun() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        token.initialize("WrappedTARI", "wTARI", "1", user);

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        controller.initialize(address(token), user, user, user, 1);

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        bridge.initialize(user);
    }

    function test_mint_low_only_by_low_safe() public {
        vm.prank(safeOwner);
        lowSafe.exec(address(controller), abi.encodeCall(wTARIController.mintLowAmount, (user, 1000 ether)));
        assertEq(token.balanceOf(user), 1000 ether);

        vm.prank(safeOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                address(highSafe),
                LOW_MINTER_ROLE
            )
        );
        highSafe.exec(address(controller), abi.encodeCall(wTARIController.mintLowAmount, (user, 1000 ether)));

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, user, LOW_MINTER_ROLE)
        );
        controller.mintLowAmount(user, 1000 ether);
    }

    function test_mint_high_only_by_high_safe() public {
        vm.prank(safeOwner);
        highSafe.exec(address(controller), abi.encodeCall(wTARIController.mintHighAmount, (user, 200_000 ether)));
        assertEq(token.balanceOf(user), 200_000 ether);

        vm.prank(safeOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                address(lowSafe),
                HIGH_MINTER_ROLE
            )
        );
        lowSafe.exec(address(controller), abi.encodeCall(wTARIController.mintHighAmount, (user, 200_000 ether)));

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, user, HIGH_MINTER_ROLE)
        );
        controller.mintHighAmount(user, 200_000 ether);
    }

    function test_low_mint_daily_limit() public {
        vm.warp(10 days + 1 hours);
        bytes memory mint100k = abi.encodeCall(wTARIController.mintLowAmount, (user, 100_000 ether));
        bytes memory mint50k = abi.encodeCall(wTARIController.mintLowAmount, (user, 50_000 ether));

        vm.startPrank(safeOwner);
        lowSafe.exec(address(controller), mint100k);
        lowSafe.exec(address(controller), mint100k);
        lowSafe.exec(address(controller), mint50k);
        assertEq(controller.lowMintedInWindow(), LOW_MINT_DAILY_LIMIT);

        vm.expectRevert(wTARIController.LowMintDailyLimitExceeded.selector);
        lowSafe.exec(address(controller), abi.encodeCall(wTARIController.mintLowAmount, (user, 1)));

        // The budget resets when the next 24h window starts.
        vm.warp(11 days);
        lowSafe.exec(address(controller), mint100k);
        assertEq(controller.lowMintedInWindow(), 100_000 ether);

        // High-tier mints do not use the low-tier budget.
        highSafe.exec(address(controller), abi.encodeCall(wTARIController.mintHighAmount, (user, 1_000_000 ether)));
        vm.stopPrank();
        assertEq(token.balanceOf(user), 1_350_000 ether);
    }

    function test_low_mint_daily_limit_only_set_by_admin() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, user, bytes32(0))
        );
        controller.setLowMintDailyLimit(1);

        vm.prank(admin);
        vm.expectEmit(true, true, true, true, address(controller));
        emit wTARIController.LowMintDailyLimitSet(0);
        controller.setLowMintDailyLimit(0);

        vm.prank(safeOwner);
        vm.expectRevert(wTARIController.LowMintDailyLimitExceeded.selector);
        lowSafe.exec(address(controller), abi.encodeCall(wTARIController.mintLowAmount, (user, 1)));
    }

    function test_bridge_rejects_empty_or_oversized_target() public {
        vm.prank(safeOwner);
        lowSafe.exec(address(controller), abi.encodeCall(wTARIController.mintLowAmount, (user, 3000 ether)));

        bytes memory tooLong = new bytes(129);
        for (uint256 i = 0; i < tooLong.length; i++) tooLong[i] = "a";

        vm.startPrank(user);
        token.approve(address(bridge), 3000 ether);
        vm.expectRevert(wTARIBridge.InvalidTargetTariAddress.selector);
        bridge.bridgeToTari("", 1000 ether);
        vm.expectRevert(wTARIBridge.InvalidTargetTariAddress.selector);
        bridge.bridgeToTari(string(tooLong), 1000 ether);
        vm.expectRevert(wTARIBridge.InvalidTargetTariAddress.selector);
        bridge.bridgeToTariWithAuthorization("", 1000 ether, 0, block.timestamp + 1, bytes32(0), 0, 0, 0);

        // 128 bytes is still accepted.
        bridge.bridgeToTari(string(new bytes(128)), 1000 ether);
        vm.stopPrank();
    }

    function test_authorization_expires_at_valid_before() public {
        vm.prank(safeOwner);
        lowSafe.exec(address(controller), abi.encodeCall(wTARIController.mintLowAmount, (user, 3000 ether)));
        uint256 validBefore = block.timestamp + 1 hours;

        (uint8 v, bytes32 r, bytes32 s) = _signReceive(1000 ether, validBefore, keccak256("a"));
        vm.warp(validBefore);
        vm.prank(user);
        vm.expectRevert(EIP3009.EIP3009_AuthorizationExpired.selector);
        bridge.bridgeToTariWithAuthorization(OOTLE_ADDRESS, 1000 ether, 0, validBefore, keccak256("a"), v, r, s);

        // One second earlier the same kind of authorization is still valid.
        vm.warp(validBefore - 1);
        (v, r, s) = _signReceive(1000 ether, validBefore, keccak256("b"));
        vm.prank(user);
        bridge.bridgeToTariWithAuthorization(OOTLE_ADDRESS, 1000 ether, 0, validBefore, keccak256("b"), v, r, s);
        assertEq(token.balanceOf(user), 2000 ether);
    }

    function test_mint_then_bridge_to_tari_emits_nonce_zero() public {
        vm.prank(safeOwner);
        lowSafe.exec(address(controller), abi.encodeCall(wTARIController.mintLowAmount, (user, 3000 ether)));

        vm.startPrank(user);
        token.approve(address(bridge), 3000 ether);
        vm.expectEmit(true, true, true, true, address(bridge));
        emit TokensUnwrapped(user, OOTLE_ADDRESS, 3000 ether, 0);
        bridge.bridgeToTari(OOTLE_ADDRESS, 3000 ether);
        vm.stopPrank();

        assertEq(token.balanceOf(user), 0);
        assertEq(token.totalSupply(), 0);
    }

    function test_mint_then_bridge_with_authorization_emits_nonce_zero() public {
        vm.prank(safeOwner);
        lowSafe.exec(address(controller), abi.encodeCall(wTARIController.mintLowAmount, (user, 3000 ether)));

        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 authNonce = keccak256("auth-nonce");
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(3000 ether, validBefore, authNonce);

        vm.prank(user);
        vm.expectEmit(true, true, true, true, address(bridge));
        emit TokensUnwrapped(user, OOTLE_ADDRESS, 3000 ether, 0);
        bridge.bridgeToTariWithAuthorization(OOTLE_ADDRESS, 3000 ether, 0, validBefore, authNonce, v, r, s);

        assertEq(token.balanceOf(user), 0);
    }

    function test_rejects_zero_mint_and_zero_address_init_and_malformed_eip3009_sig() public {
        vm.startPrank(safeOwner);
        vm.expectRevert(wTARI.ZeroAmount.selector);
        lowSafe.exec(address(controller), abi.encodeCall(wTARIController.mintLowAmount, (user, 0)));

        vm.expectRevert(wTARI.ZeroAmount.selector);
        highSafe.exec(address(controller), abi.encodeCall(wTARIController.mintHighAmount, (user, 0)));
        vm.stopPrank();

        // Zero-address initializer guards on all 4 parameters of wTARIController and wTARIBridge
        wTARIController controllerImpl = new wTARIController();
        vm.expectRevert(wTARIController.ZeroAddress.selector);
        new TransparentUpgradeableProxy(
            address(controllerImpl),
            admin,
            abi.encodeWithSelector(
                wTARIController.initialize.selector,
                address(0),
                address(lowSafe),
                address(highSafe),
                admin,
                LOW_MINT_DAILY_LIMIT
            )
        );
        vm.expectRevert(wTARIController.ZeroAddress.selector);
        new TransparentUpgradeableProxy(
            address(controllerImpl),
            admin,
            abi.encodeWithSelector(
                wTARIController.initialize.selector,
                address(token),
                address(0),
                address(highSafe),
                admin,
                LOW_MINT_DAILY_LIMIT
            )
        );
        vm.expectRevert(wTARIController.ZeroAddress.selector);
        new TransparentUpgradeableProxy(
            address(controllerImpl),
            admin,
            abi.encodeWithSelector(
                wTARIController.initialize.selector,
                address(token),
                address(lowSafe),
                address(0),
                admin,
                LOW_MINT_DAILY_LIMIT
            )
        );
        vm.expectRevert(wTARIController.ZeroAddress.selector);
        new TransparentUpgradeableProxy(
            address(controllerImpl),
            admin,
            abi.encodeWithSelector(
                wTARIController.initialize.selector,
                address(token),
                address(lowSafe),
                address(highSafe),
                address(0),
                LOW_MINT_DAILY_LIMIT
            )
        );

        wTARIBridge bridgeImpl = new wTARIBridge();
        vm.expectRevert(wTARIBridge.ZeroAddress.selector);
        new TransparentUpgradeableProxy(
            address(bridgeImpl),
            admin,
            abi.encodeWithSelector(wTARIBridge.initialize.selector, address(0))
        );

        wTARI tokenImpl = new wTARI(address(endpoints[aEid]));
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableInvalidOwner.selector, address(0)));
        new TransparentUpgradeableProxy(
            address(tokenImpl),
            admin,
            abi.encodeWithSelector(wTARI.initialize.selector, "Wrapped Tari", "wTARI", "1", address(0))
        );

        // Malformed EIP-3009 signatures (v=0 and malleable high-s) revert with EIP3009_InvalidSignature
        vm.prank(user);
        vm.expectRevert(EIP3009.EIP3009_InvalidSignature.selector);
        bridge.bridgeToTariWithAuthorization(
            OOTLE_ADDRESS,
            1000 ether,
            0,
            block.timestamp + 1 hours,
            keccak256("bad-sig"),
            0,
            bytes32(0),
            bytes32(0)
        );

        vm.expectRevert(EIP3009.EIP3009_InvalidSignature.selector);
        token.transferWithAuthorization(
            user,
            admin,
            100 ether,
            0,
            block.timestamp + 1 hours,
            keccak256("bad-transfer-sig"),
            27,
            bytes32(uint256(1)),
            bytes32(uint256(0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A1))
        );

        vm.expectRevert(EIP3009.EIP3009_InvalidSignature.selector);
        token.cancelAuthorization(user, keccak256("bad-cancel-sig"), 0, bytes32(0), bytes32(0));
    }

    function _signReceive(
        uint256 value,
        uint256 validBefore,
        bytes32 authNonce
    ) internal view returns (uint8, bytes32, bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                user,
                address(bridge),
                value,
                0,
                validBefore,
                authNonce
            )
        );
        return vm.sign(userKey, keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash)));
    }

    function _domainSeparator() internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256("wTARI"),
                    keccak256("1"),
                    block.chainid,
                    address(token)
                )
            );
    }

    function _deployContractAndProxy(
        bytes memory _bytecode,
        bytes memory _constructorArgs,
        bytes memory _initializeArgs
    ) internal returns (address addr) {
        bytes memory bytecode = bytes.concat(_bytecode, _constructorArgs);
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
            if iszero(extcodesize(addr)) {
                revert(0, 0)
            }
        }
        return address(new TransparentUpgradeableProxy(addr, admin, _initializeArgs));
    }
}
