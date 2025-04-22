// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { Script, console } from "forge-std/Script.sol";

interface IwXTM {
    function mint(address _to, uint256 _amount) external;
    function approve(address _spender, uint256 _amount) external;
    function burn(uint256 _amount) external;
    function owner() external;
    function transferOwnership(address _newOwner) external;
}

contract CallProxy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        address proxyAddress = 0xcBe79AB990E0Ab45Cb9148db7d434477E49b7374;
        address wXTMBridge = 0x0774838a6Bf49D1125b3426d87D8F831607B1e0A;

        vm.startBroadcast(deployerKey);

        IwXTM proxy = IwXTM(proxyAddress);
        // proxy.transferOwnership(0x2E2E8F5B7B63684DD404B1c4236A4a172Cbb125d);
        proxy.approve(wXTMBridge, 0.03 ether);
        // proxy.burn(0.2 ether);
        // proxy.owner();
        // proxy.mint(0x8E3E50D2149FCA8B3EE2367199CaA4054105bD16, 10_000_000);

        vm.stopBroadcast();
    }
}
