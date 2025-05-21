// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

interface IwXTMController {
    function LOW_MINTER_ROLE() external view returns (bytes32);
    function HIGH_MINTER_ROLE() external view returns (bytes32);
    function hasRole(bytes32 role, address account) external view returns (bool);
}
