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

async function exportDeploymentsAddresses(path_directory: string) {
    //@ts-ignore
    const chainId = await hre.getChainId()

    //@ts-ignore
    const deployments = await hre.deployments.all()

    if (!fs.existsSync(path_directory)) {
        fs.mkdirSync(path_directory)
    }
    const file = `${path_directory}/deployments.json`
    const exported: { [chainId: string]: ExportedEntry } = fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, 'utf8'))
        : {}
    const previous: ExportedEntry = exported[chainId] ?? {}

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

    exported[chainId] = entry
    fs.writeFileSync(file, JSON.stringify(exported, null, 2))
    if (wtariFailed) process.exitCode = 1
}

exportDeploymentsAddresses('./wxtm-bridge-contracts-typechain/deployments').catch((e) => {
    console.error(e)
    process.exitCode = 1
})
