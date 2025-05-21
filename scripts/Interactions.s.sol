// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { Script, console } from "forge-std/Script.sol";

import { IOFT, SendParam } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { MessagingFee, MessagingReceipt } from "@layerzerolabs/oft-evm/contracts/OFTCore.sol";

interface IwXTM {
    function mint(address _to, uint256 _amount) external;
    function approve(address _spender, uint256 _amount) external;
    function burn(uint256 _amount) external;
    function owner() external;
    function transferOwnership(address _newOwner) external;
    function setPeer(uint32 _eid, bytes32 _peer) external;
    function quoteSend(
        SendParam calldata _sendParam,
        bool _payInLzToken
    ) external view returns (uint256 nativeFee, uint256 lzTokenFee);
    function send(SendParam calldata _sendParam, MessagingFee calldata _fee, address _refundAddress) external payable;
    function grantRole(bytes32 role, address account) external;
}

contract SetMinter is Script {
    bytes32 private constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 private constant LOW_MINTER_ROLE = keccak256("LOW_MINTER_ROLE");
    bytes32 private constant HIGH_MINTER_ROLE = keccak256("HIGH_MINTER_ROLE");

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        address proxyAddress = 0x31999d652476b9e2ef4DEbA560CD39b9Af1AccA5;
        address controller = 0x8aead919E7716a0840cB84495fA1AC76e04f7845;

        vm.startBroadcast(deployerKey);

        IwXTM proxy = IwXTM(proxyAddress);
        proxy.grantRole(HIGH_MINTER_ROLE, controller);

        vm.stopBroadcast();
    }
}

contract CallProxy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        address proxyAddress = 0xcBe79AB990E0Ab45Cb9148db7d434477E49b7374;
        // address wXTMBridge = 0x0774838a6Bf49D1125b3426d87D8F831607B1e0A;

        vm.startBroadcast(deployerKey);

        IwXTM proxy = IwXTM(proxyAddress);
        // proxy.transferOwnership(0x2E2E8F5B7B63684DD404B1c4236A4a172Cbb125d);
        // proxy.approve(wXTMBridge, 0.03 ether);
        // proxy.burn(0.2 ether);
        proxy.owner();
        // proxy.mint(0x8E3E50D2149FCA8B3EE2367199CaA4054105bD16, 10_000_000);

        vm.stopBroadcast();
    }
}

contract SetPeer is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        address proxyAddress = 0xcBe79AB990E0Ab45Cb9148db7d434477E49b7374;
        IwXTM proxy = IwXTM(proxyAddress);

        uint32 eid = 40161; // Sepolia
        // uint32 eid = 40245; // Base Sepolia

        vm.startBroadcast(deployerKey);

        proxy.setPeer(eid, bytes32(uint256(uint160(0xcBe79AB990E0Ab45Cb9148db7d434477E49b7374))));

        vm.stopBroadcast();
    }
}

contract SendTokens is Script {
    using OptionsBuilder for bytes;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        address proxyAddress = 0xcBe79AB990E0Ab45Cb9148db7d434477E49b7374;
        IwXTM proxy = IwXTM(proxyAddress);

        uint256 wXTMToSend = 0.1 ether;
        uint32 sepoliaEid = 40161;
        // uint32 baseSepoliaEid = 40245;
        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0);

        SendParam memory sendParam = SendParam(
            sepoliaEid,
            bytes32(uint256(uint160(0x226F0e896a78A1848e4Fa25ce901108F0d61c7f3))),
            wXTMToSend,
            wXTMToSend,
            options,
            "",
            ""
        );

        vm.startBroadcast(deployerKey);

        (uint256 nativeFee, uint256 lzTokenFee) = proxy.quoteSend(sendParam, false);
        console.log("Estimated native fee: %s", nativeFee);

        MessagingFee memory fee = MessagingFee({ nativeFee: nativeFee, lzTokenFee: lzTokenFee });

        proxy.send{ value: nativeFee }(sendParam, fee, payable(msg.sender));

        vm.stopBroadcast();
    }
}
