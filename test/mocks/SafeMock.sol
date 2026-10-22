// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @dev Minimal stand-in for a Gnosis Safe: owners/threshold getters and an owner-only call forwarder.
contract SafeMock {
    address[] private owners;
    uint256 private threshold;

    constructor(address[] memory _owners, uint256 _threshold) {
        owners = _owners;
        threshold = _threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function exec(address to, bytes calldata data) external returns (bytes memory) {
        bool isOwner = false;
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == msg.sender) isOwner = true;
        }
        require(isOwner, "not an owner");

        (bool ok, bytes memory result) = to.call(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        return result;
    }
}
