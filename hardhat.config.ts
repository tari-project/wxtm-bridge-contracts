import 'dotenv/config'
import '@layerzerolabs/toolbox-hardhat'
import 'hardhat-contract-sizer'

import 'hardhat-contract-sizer'
import 'hardhat-typechain'

import '@rumblefishdev/hardhat-kms-signer'

import type { HttpNetworkAccountsUserConfig } from 'hardhat/types/config'
import { defineConfig, HardhatUserConfig } from 'hardhat/config'
import { EndpointId } from '@layerzerolabs/lz-definitions'

/** @dev Uncomment below to use standard authentication method */
// // Set your preferred authentication method
// //
// // If you prefer using a mnemonic, set a MNEMONIC environment variable
// // to a valid mnemonic
const MNEMONIC = process.env.MNEMONIC

// If you prefer to be authenticated using a private key, set a PRIVATE_KEY environment variable
const PRIVATE_KEY = process.env.PRIVATE_KEY

const accounts: HttpNetworkAccountsUserConfig | undefined = MNEMONIC
    ? { mnemonic: MNEMONIC }
    : PRIVATE_KEY
      ? [PRIVATE_KEY]
      : undefined

if (accounts == null) {
    console.warn(
        'Could not find MNEMONIC or PRIVATE_KEY environment variables. It will not be possible to execute transactions in your example.'
    )
}
export default defineConfig({
    typechain: {
        outDir: 'typechain',
    },
    paths: {
        cache: 'cache/hardhat',
    },
    solidity: {
        compilers: [
            {
                version: '0.8.24',
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 200,
                    },
                },
            },
        ],
    },
    networks: {
        /** @dev If using 'KMS_KEY_ID' for safety remove/comment 'PRIVATE_KEY' variable from .env file */
        mainnet: {
            type: 'http',
            chainId: EndpointId.ETHEREUM_MAINNET,
            url: 'https://eth-mainnet.g.alchemy.com/v2/<ALCHEMY_MAINNET_API_KEY>',
            // url: process.env.MAINNET_RPC_URL || '',
            // kmsKeyId: process.env.KMS_KEY_ID,
        },
    },

    etherscan: {
        apiKey: process.env.ETHERSCAN_API_KEY,
    },
    sourcify: {
        // Disabled by default -> Doesn't need an API key
        enabled: true,
    },
    namedAccounts: {
        deployer: {
            default: 0, // wallet address of index[0], of the mnemonic in .env
        },
    },
} as HardhatUserConfig)
