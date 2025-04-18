// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

interface IwXTM {
    function mint(address _to, uint256 _amount) external;

    function burn(uint256 _amount) external;

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
