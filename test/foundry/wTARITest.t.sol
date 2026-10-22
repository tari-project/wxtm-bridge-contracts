// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { wTARI } from "../../contracts/wTARI.sol";
import { wTARIBridge } from "../../contracts/wTARIBridge.sol";
import { wTARIController } from "../../contracts/wTARIController.sol";
import { SafeMock } from "../mocks/SafeMock.sol";

import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { TransparentUpgradeableProxy } from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

contract wTARITest is TestHelperOz5 {
    event TokensUnwrapped(address from, string targetTariAddress, uint256 amount, uint256 nonce);

    bytes32 private constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 private constant LOW_MINTER_ROLE = keccak256("LOW_MINTER_ROLE");
    bytes32 private constant HIGH_MINTER_ROLE = keccak256("HIGH_MINTER_ROLE");
    string private constant OOTLE_ADDRESS =
        "otl_esm_1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7v9kn6";

    uint32 private aEid = 1;

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
        lowSafe = new SafeMock(owners, 1);
        highSafe = new SafeMock(owners, 1);

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
                    admin
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
        controller.initialize(address(token), user, user, user);

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
        bytes32 structHash = keccak256(
            abi.encode(
                token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                user,
                address(bridge),
                3000 ether,
                0,
                validBefore,
                authNonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            userKey,
            keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash))
        );

        vm.prank(user);
        vm.expectEmit(true, true, true, true, address(bridge));
        emit TokensUnwrapped(user, OOTLE_ADDRESS, 3000 ether, 0);
        bridge.bridgeToTariWithAuthorization(OOTLE_ADDRESS, 3000 ether, 0, validBefore, authNonce, v, r, s);

        assertEq(token.balanceOf(user), 0);
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
