// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

abstract contract EIP3009 is ERC20Upgradeable, EIP712Upgradeable {
    error EIP3009_AuthorizationNotYetValid();
    error EIP3009_AuthorizationExpired();
    error EIP3009_AuthorizationUsed();
    error EIP3009_InvalidSignature();
    error EIP3009_UnauthorizedCaller();

    // keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;

    // keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;

    // keccak256("CancelAuthorization(address authorizer,bytes32 nonce)")
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429;

    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    /**
     * @notice Returns the state of an authorization
     * @dev Nonces are randomly generated 32-byte data unique to the authorizer's address
     * @param authorizer    Authorizer's address
     * @param nonce         Nonce of the authorization
     * @return True if the nonce is used
     */
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /**
     * @notice Burns wXTM tokens after verification
     * @dev EOA wallet signatures should be packed in the order of r, s, v.
     * @param from          Address authorizing the burn (must hold sufficient balance)
     * @param to            Address that receive original tokens on the Tari blockchain
     * @param value         Amount of wXTM tokens to burn
     * @param validAfter    Timestamp after which the authorization is valid
     * @param validBefore   Timestamp (unix time) before which the authorization expires
     * @param nonce         Unique identifier to prevent replay attacks
     * @param v             Signature component.
     * @param r             Signature component.
     * @param s             Signature component.
     */
    function _transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        _transferWithAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce,
            v,
            r,
            s
        );
    }

    /**
     * @notice Mints wXTM tokens after verification
     * @dev This has an additional check to ensure that the payee's address
     * matches the caller of this function to prevent front-running attacks.
     * EOA wallet signatures should be packed in the order of r, s, v.
     * @param from          Address authorizing the mint (original token owner on Tari blockchain)
     * @param to            Address receiving the minted tokens
     * @param value         Amount of wXTM tokens to mint
     * @param validAfter    Timestamp after which the authorization is valid
     * @param validBefore   Timestamp (unix time) before which the authorization expires
     * @param nonce         Unique identifier to prevent replay attacks
     * @param v             Signature component.
     * @param r             Signature component.
     * @param s             Signature component.
     */
    function _receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        /** @dev Prevent front-running: only 'to' address can execute this */
        if (msg.sender != to) revert EIP3009_UnauthorizedCaller();

        _transferWithAuthorization(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce,
            v,
            r,
            s
        );
    }

    /**
     * @notice Attempt to cancel an authorization
     * @param authorizer    Authorizer's address
     * @param nonce         Nonce of the authorization
     * @param v             v of the signature
     * @param r             r of the signature
     * @param s             s of the signature
     */
    function _cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) internal {
        if (_authorizationStates[authorizer][nonce]) revert EIP3009_AuthorizationUsed();
        _requireValidSignature(
            authorizer,
            keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)),
            abi.encodePacked(r, s, v)
        );

        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _transferWithAuthorization(
        bytes32 typeHash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        if (block.timestamp < validAfter) revert EIP3009_AuthorizationNotYetValid();
        if (block.timestamp > validBefore) revert EIP3009_AuthorizationExpired();
        if (_authorizationStates[from][nonce]) revert EIP3009_AuthorizationUsed();

        /** @dev Prevent reentrancy attack */
        _authorizationStates[from][nonce] = true;

        _requireValidSignature(
            from,
            keccak256(abi.encode(typeHash, from, to, value, validAfter, validBefore, nonce)),
            abi.encodePacked(r, s, v)
        );

        emit AuthorizationUsed(from, nonce);

        _transfer(from, to, value);
    }

    /**
     * @notice Validates that signature against input data struct
     * @param signer        Signer's address
     * @param dataHash      Hash of encoded data struct
     * @param signature     Signature byte array produced by an EOA wallet or a contract wallet
     */
    function _requireValidSignature(address signer, bytes32 dataHash, bytes memory signature) private view {
        if (signer != ECDSA.recover(_hashTypedDataV4(dataHash), signature)) revert EIP3009_InvalidSignature();
    }
}
