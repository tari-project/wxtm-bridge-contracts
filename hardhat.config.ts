import { defineConfig, HardhatUserConfig } from 'hardhat/config'
import { EndpointId } from '@layerzerolabs/lz-definitions'

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
