import * as fs from 'fs'

import hre from 'hardhat'

import {
    ExportedEntry,
    checkWtariDeployment,
    exportedChainEntry,
    hasWtariConfig,
    readWtariConfig,
    referenceProviderFor,
    withRedactedRpcUrls,
} from '../../tasks/wtari'
import { readManifest, updateManifestEntry } from '../../utils/deployments-manifest'

async function exportDeploymentsAddresses(path_directory: string) {
    //@ts-ignore
    const chainId = await hre.getChainId()

    //@ts-ignore
    const deployments = await hre.deployments.all()

    if (!fs.existsSync(path_directory)) {
        fs.mkdirSync(path_directory)
    }
    const file = `${path_directory}/deployments.json`
    // Snapshot of this chain's entry; the file is re-read under a lock before writing (see below).
    const previousEntry = readManifest<ExportedEntry>(file)[chainId]
    const previous: ExportedEntry = previousEntry ?? {}

    const addresses: { [name: string]: string } = {}
    for (const name of Object.keys(deployments)) addresses[name] = deployments[name].address

    const configuredStartBlock = hasWtariConfig(Number(chainId))
        ? readWtariConfig(Number(chainId)).bridgeStartBlock
        : undefined
    const { entry, wtariFailed } = await exportedChainEntry(previous, addresses, configuredStartBlock, async () => {
        const config = readWtariConfig(Number(chainId))
        let bridgeStartBlock = 0
        await withRedactedRpcUrls(config, async () => {
            bridgeStartBlock = (await checkWtariDeployment(hre, config, referenceProviderFor(config))).bridgeStartBlock
        })
        return bridgeStartBlock
    })
    if (wtariFailed) console.warn(`WARNING: new wTARI entries for chain ${chainId} were not exported.`)

    // Other chains may have been exported concurrently: merge under a lock and replace the file atomically.
    await updateManifestEntry(file, String(chainId), previousEntry, entry)
    if (wtariFailed) process.exitCode = 1
}

exportDeploymentsAddresses('./wxtm-bridge-contracts-typechain/deployments').catch((e) => {
    console.error(e)
    process.exitCode = 1
})
