// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import {EIP712} from "./EIP712.sol";

abstract contract EIP712Domain {
    bytes32 public DOMAIN_SEPARATOR;

    constructor(string memory name, string memory version) {
        DOMAIN_SEPARATOR = EIP712.makeDomainSeparator(name, version);
    }
}
