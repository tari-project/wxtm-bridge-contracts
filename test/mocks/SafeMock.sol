// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @dev Minimal stand-in for a Gnosis Safe proxy: singleton in slot 0, owners/threshold/modules getters,
/// an owner-only call forwarder, and Safe's FallbackManager forwarding when the fallback handler slot is set.
contract SafeMock {
    // Same signature as a real Safe (v1.3+), which emits it for every successful Safe transaction.
    event ExecutionSuccess(bytes32 txHash, uint256 payment);

    // keccak256("fallback_manager.handler.address")
    bytes32 private constant FALLBACK_HANDLER_STORAGE_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    address private singleton;
    address[] private owners;
    uint256 private threshold;
    address[] private modules;

    constructor(address _singleton, address[] memory _owners, uint256 _threshold) {
        singleton = _singleton;
        owners = _owners;
        threshold = _threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function getModulesPaginated(address, uint256) external view returns (address[] memory, address) {
        return (modules, address(1));
    }

    /// @dev Test helper; a real Safe only enables modules through a Safe transaction.
    function addModule(address module) external {
        modules.push(module);
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
        emit ExecutionSuccess(keccak256(data), 0);
        return result;
    }

    fallback() external {
        bytes32 slot = FALLBACK_HANDLER_STORAGE_SLOT;
        assembly {
            let handler := sload(slot)
            if iszero(handler) {
                return(0, 0)
            }
            calldatacopy(0, 0, calldatasize())
            mstore(calldatasize(), shl(96, caller()))
            let success := call(gas(), handler, 0, 0, add(calldatasize(), 20), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(success) {
                revert(0, returndatasize())
            }
            return(0, returndatasize())
        }
    }
}
