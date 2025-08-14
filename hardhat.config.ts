import 'dotenv/config'

import 'hardhat-deploy'
import 'hardhat-contract-sizer'
import '@nomiclabs/hardhat-ethers'
import '@layerzerolabs/toolbox-hardhat'
import '@typechain/hardhat'

import '@openzeppelin/hardhat-upgrades'
import '@nomicfoundation/hardhat-verify'
import '@rumblefishdev/hardhat-kms-signer'
import { HardhatUserConfig /* HttpNetworkAccountsUserConfig */ } from 'hardhat/types'

import { EndpointId } from '@layerzerolabs/lz-definitions'

/** @dev Uncomment below to use standard authentication method */
// // Set your preferred authentication method
// //
// // If you prefer using a mnemonic, set a MNEMONIC environment variable
// // to a valid mnemonic
// const MNEMONIC = process.env.MNEMONIC

// // If you prefer to be authenticated using a private key, set a PRIVATE_KEY environment variable
// const PRIVATE_KEY = process.env.PRIVATE_KEY

// const accounts: HttpNetworkAccountsUserConfig | undefined = MNEMONIC
//     ? { mnemonic: MNEMONIC }
//     : PRIVATE_KEY
//       ? [PRIVATE_KEY]
//       : undefined

// if (accounts == null) {
//     console.warn(
//         'Could not find MNEMONIC or PRIVATE_KEY environment variables. It will not be possible to execute transactions in your example.'
//     )
// }

const config: HardhatUserConfig = {
    paths: {
        cache: 'cache/hardhat',
    },
    solidity: {
        compilers: [
            {
                version: '0.8.22',
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
        // mainnet: {
        //     eid: EndpointId.ETHEREUM_MAINNET,
        //     url: process.env.MAINNET_RPC_URL || '',
        //     kmsKeyId: process.env.KMS_KEY_ID,
        // },
        'sepolia-testnet': {
            eid: EndpointId.SEPOLIA_V2_TESTNET,
            url: process.env.SEPOLIA_RPC_URL || 'https://1rpc.io/sepolia',
            kmsKeyId: process.env.KMS_KEY_ID,
        },
        // 'base-sepolia-testnet': {
        //     eid: EndpointId.BASESEP_V2_TESTNET,
        //     url: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
        //     accounts,
        // },
        // 'optimism-testnet': {
        //     eid: EndpointId.OPTSEP_V2_TESTNET,
        //     url: process.env.RPC_URL_OP_SEPOLIA || 'https://optimism-sepolia.gateway.tenderly.co',
        //     accounts,
        // },
        // 'avalanche-testnet': {
        //     eid: EndpointId.AVALANCHE_V2_TESTNET,
        //     url: process.env.RPC_URL_FUJI || 'https://avalanche-fuji.drpc.org',
        //     accounts,
        // },
        // 'arbitrum-testnet': {
        //     eid: EndpointId.ARBSEP_V2_TESTNET,
        //     url: process.env.RPC_URL_ARB_SEPOLIA || 'https://arbitrum-sepolia.gateway.tenderly.co',
        //     accounts,
        // },
        hardhat: {
            // Need this for testing because TestHelperOz5.sol is exceeding the compiled contract size limit
            allowUnlimitedContractSize: true,
        },
    },
    typechain: {
        outDir: 'typechain',
        target: 'ethers-v5',
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
}

export default config
