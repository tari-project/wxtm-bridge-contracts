// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

// Contract imports
import { wXTM } from "../../contracts/wXTM.sol";
import { wXTMController } from "../../contracts/wXTMController.sol";

// Mock imports
import { ERC20Mock } from "../mocks/ERC20Mock.sol";
import { OFTComposerMock } from "../mocks/OFTComposerMock.sol";

// OApp imports
import { IOAppOptionsType3, EnforcedOptionParam } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OAppOptionsType3.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";

// OFT imports
import { IOFT, SendParam, OFTReceipt } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { MessagingFee, MessagingReceipt } from "@layerzerolabs/oft-evm/contracts/OFTCore.sol";
import { OFTMsgCodec } from "@layerzerolabs/oft-evm/contracts/libs/OFTMsgCodec.sol";
import { OFTComposeMsgCodec } from "@layerzerolabs/oft-evm/contracts/libs/OFTComposeMsgCodec.sol";
import { EndpointV2Mock } from "@layerzerolabs/test-devtools-evm-foundry/contracts/mocks/EndpointV2Mock.sol";

// OZ imports
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { TransparentUpgradeableProxy } from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

// Forge imports
import "forge-std/console.sol";

// DevTools imports
import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";

contract wXTMTest is TestHelperOz5 {
    using OptionsBuilder for bytes;

    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint32 private aEid = 1; // 40161 -> Sepolia;
    uint32 private bEid = 2; // 40245 -> Base Sepolia;

    wXTMController private aController;
    wXTMController private bController;
    wXTM private aOFT;
    wXTM private bOFT;

    address private proxyAdmin = makeAddr("proxyAdmin");
    address private userA = makeAddr("userA");
    address private userB = makeAddr("userB");
    address private admin = makeAddr("admin");
    address private lowMinter = makeAddr("lowMinter");
    address private highMinter = makeAddr("highMinter");

    uint256 private constant INITIAL_BALANCE = 100 ether;

    function setUp() public virtual override {
        vm.deal(proxyAdmin, 1000 ether);
        vm.deal(userA, INITIAL_BALANCE);
        vm.deal(userB, INITIAL_BALANCE);
        vm.deal(admin, INITIAL_BALANCE);
        vm.deal(lowMinter, INITIAL_BALANCE);
        vm.deal(highMinter, INITIAL_BALANCE);

        super.setUp();
        setUpEndpoints(2, LibraryType.UltraLightNode);

        aOFT = wXTM(
            _deployContractAndProxy(
                type(wXTM).creationCode,
                abi.encode(address(endpoints[aEid])),
                abi.encodeWithSelector(wXTM.initialize.selector, "aOFT", "aOFT", "1", address(this))
            )
        );

        bOFT = wXTM(
            _deployContractAndProxy(
                type(wXTM).creationCode,
                abi.encode(address(endpoints[bEid])),
                abi.encodeWithSelector(wXTM.initialize.selector, "bOFT", "bOFT", "1", address(this))
            )
        );

        vm.prank(admin);
        aController = wXTMController(
            _deployContractAndProxy(
                type(wXTMController).creationCode,
                abi.encode(),
                abi.encodeWithSelector(wXTMController.initialize.selector, address(aOFT), lowMinter, highMinter, admin)
            )
        );

        vm.prank(admin);
        bController = wXTMController(
            _deployContractAndProxy(
                type(wXTMController).creationCode,
                abi.encode(),
                abi.encodeWithSelector(wXTMController.initialize.selector, address(bOFT), lowMinter, highMinter, admin)
            )
        );

        /** @dev Assign MINTER_ROLE */
        aOFT.grantRole(MINTER_ROLE, address(aController));
        bOFT.grantRole(MINTER_ROLE, address(bController));

        /** @dev Config and wire the ofts */
        address[] memory ofts = new address[](2);
        ofts[0] = address(aOFT);
        ofts[1] = address(bOFT);
        this.wireOApps(ofts);

        vm.prank(address(aController));
        aOFT.mint(userA, INITIAL_BALANCE);

        vm.prank(address(bController));
        bOFT.mint(userB, INITIAL_BALANCE);
    }

    function test_wxtm_constructor() public view {
        assertEq(aOFT.owner(), address(this));
        assertEq(bOFT.owner(), address(this));

        assertEq(aOFT.balanceOf(userA), INITIAL_BALANCE);
        assertEq(bOFT.balanceOf(userB), INITIAL_BALANCE);

        assertEq(aOFT.token(), address(aOFT));
        assertEq(bOFT.token(), address(bOFT));
    }

    function test_unauthorized_cannot_mint() public {
        vm.prank(address(777));
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, address(777), MINTER_ROLE)
        );
        aOFT.mint(userA, INITIAL_BALANCE);
    }

    function test_send_wxtm_oft() public {
        uint256 tokensToSend = 1 ether;
        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(200000, 0);

        SendParam memory sendParam = SendParam(
            bEid,
            addressToBytes32(userB),
            tokensToSend,
            tokensToSend,
            options,
            "",
            ""
        );
        MessagingFee memory fee = aOFT.quoteSend(sendParam, false);

        assertEq(aOFT.balanceOf(userA), INITIAL_BALANCE);
        assertEq(bOFT.balanceOf(userB), INITIAL_BALANCE);

        vm.prank(userA);
        aOFT.send{ value: fee.nativeFee }(sendParam, fee, payable(address(this)));
        verifyPackets(bEid, addressToBytes32(address(bOFT)));

        assertEq(aOFT.balanceOf(userA), INITIAL_BALANCE - tokensToSend);
        assertEq(bOFT.balanceOf(userB), INITIAL_BALANCE + tokensToSend);
    }

    function test_send_wxtm_oft_compose_msg() public {
        uint256 tokensToSend = 1 ether;

        OFTComposerMock composer = new OFTComposerMock();

        bytes memory options = OptionsBuilder
            .newOptions()
            .addExecutorLzReceiveOption(200000, 0)
            .addExecutorLzComposeOption(0, 500000, 0);

        bytes memory composeMsg = hex"1234";

        SendParam memory sendParam = SendParam(
            bEid,
            addressToBytes32(address(composer)),
            tokensToSend,
            tokensToSend,
            options,
            composeMsg,
            ""
        );

        MessagingFee memory fee = aOFT.quoteSend(sendParam, false);

        assertEq(aOFT.balanceOf(userA), INITIAL_BALANCE);
        assertEq(bOFT.balanceOf(address(composer)), 0);

        vm.prank(userA);
        (MessagingReceipt memory msgReceipt, OFTReceipt memory oftReceipt) = aOFT.send{ value: fee.nativeFee }(
            sendParam,
            fee,
            payable(address(this))
        );

        verifyPackets(bEid, addressToBytes32(address(bOFT)));

        // lzCompose params
        uint32 dstEid_ = bEid;
        address from_ = address(bOFT);
        bytes memory options_ = options;
        bytes32 guid_ = msgReceipt.guid;
        address to_ = address(composer);
        bytes memory composerMsg_ = OFTComposeMsgCodec.encode(
            msgReceipt.nonce,
            aEid,
            oftReceipt.amountReceivedLD,
            abi.encodePacked(addressToBytes32(userA), composeMsg)
        );

        this.lzCompose(dstEid_, from_, options_, guid_, to_, composerMsg_);

        assertEq(aOFT.balanceOf(userA), INITIAL_BALANCE - tokensToSend);
        assertEq(bOFT.balanceOf(address(composer)), tokensToSend);

        assertEq(composer.from(), from_);
        assertEq(composer.guid(), guid_);
        assertEq(composer.message(), composerMsg_);
        assertEq(composer.executor(), address(this));
        assertEq(composer.extraData(), composerMsg_); // default to setting the extraData to the message as well to test
    }

    function test_cant_burn_zero() public {
        uint amount = 0;

        vm.prank(userA);
        vm.expectRevert(wXTM.ZeroAmount.selector);
        aOFT.burn(amount);

        assertEq(aOFT.balanceOf(userA), INITIAL_BALANCE);
    }

    function test_wxtm_implementation_initialization_disabled() public {
        wXTM wxtm = wXTM(
            _deployContractAndProxy(
                type(wXTM).creationCode,
                abi.encode(address(endpoints[aEid])),
                abi.encodeWithSelector(wXTM.initialize.selector, "wxtm", "wxtm", "1", address(this))
            )
        );

        bytes32 implementationRaw = vm.load(address(wxtm), IMPLEMENTATION_SLOT);
        address implementationAddress = address(uint160(uint256(implementationRaw)));

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        aOFT.initialize("wxtm", "wxtm", "1", address(this));

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        bOFT.initialize("wxtm", "wxtm", "1", address(this));

        wXTM wxtmImplementation = wXTM(implementationAddress);

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        wxtmImplementation.initialize("wxtm", "wxtm", "1", address(this));

        EndpointV2Mock endpoint = EndpointV2Mock(address(wxtm.endpoint()));
        assertEq(endpoint.delegates(address(wxtm)), address(this));
        assertEq(endpoint.delegates(implementationAddress), address(0));
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

        return address(new TransparentUpgradeableProxy(addr, proxyAdmin, _initializeArgs));
    }
}
