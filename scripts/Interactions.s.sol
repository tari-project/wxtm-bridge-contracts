// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { Script, console } from "forge-std/Script.sol";

interface IwXTM {
    function mint(address _to, uint256 _amount) external;
    function burn(address _from, uint256 _amount) external;
    function owner() external;
    function transferOwnership(address _newOwner) external;
}

contract CallProxy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        address proxyAddress = 0xcBe79AB990E0Ab45Cb9148db7d434477E49b7374;
        // address wXTMBridge = 0x52610316B50238d0f6259691762179A3d8E87908;

        vm.startBroadcast(deployerKey);

        IwXTM proxy = IwXTM(proxyAddress);
        proxy.transferOwnership(0x2E2E8F5B7B63684DD404B1c4236A4a172Cbb125d);
        // proxy.owner();
        // proxy.mint(0x8E3E50D2149FCA8B3EE2367199CaA4054105bD16, 10_000_000);

        vm.stopBroadcast();
    }
}
