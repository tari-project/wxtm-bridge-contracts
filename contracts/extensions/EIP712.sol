// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

library EIP712 {
    error EIP712_InvalidSignature();

    /** @dev BELOW VALUE TO BE UPDATED !!! */
    // keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
    bytes32 public constant EIP712_DOMAIN_TYPEHASH = 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b178b0ffacaa9a75d522b39666f;

    /**
     * @notice Make EIP712 domain separator
     * @param name      Contract name
     * @param version   Contract version
     * @return Domain   Separator
     */
    function makeDomainSeparator(string memory name, string memory version) internal view returns (bytes32) {
        uint256 chainId;

        assembly {
            chainId := chainid()
        }

        return
            keccak256(
                abi.encode(
                    EIP712_DOMAIN_TYPEHASH,
                    keccak256(bytes(name)),
                    keccak256(bytes(version)),
                    bytes32(chainId),
                    address(this)
                )
            );
    }

    function recover(
        bytes32 domainSeparator,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes memory typeHashAndData
    ) internal pure returns (address) {
        bytes32 structHash = keccak256(typeHashAndData);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        address recovered = ecrecover(digest, v, r, s);

        if (recovered == address(0)) revert EIP712_InvalidSignature();

        return recovered;
    }
}
