import * as fs from 'fs'

import hre from 'hardhat'

import { checkWtariDeployment, readWtariConfig, referenceProviderFor, withRedactedRpcUrls } from '../../tasks/wtari'

async function exportDeploymentsAddresses(path_directory: string) {
    //@ts-ignore
    const chainId = await hre.getChainId()

    //@ts-ignore
    const deployments = await hre.deployments.all()

    const deploymentsAddresses = Object.keys(deployments).reduce(
        (acc, deployment) => {
            acc[deployment] = deployments[deployment].address

            return acc
        },
        {} as { [key: string]: string | number }
    )

    // wTARI entries are exported only after check:wtari passes; consumers start indexing TokensUnwrapped from
    // the bridge proxy's proven creation block.
    if (deployments.wTARIBridge) {
        const config = readWtariConfig(Number(chainId))
        await withRedactedRpcUrls(config, async () => {
            const { bridgeStartBlock } = await checkWtariDeployment(hre, config, referenceProviderFor(config))
            deploymentsAddresses.wTARIBridgeStartBlock = bridgeStartBlock
        })
    }

    if (!fs.existsSync(path_directory)) {
        fs.mkdirSync(path_directory)
    }

    fs.stat(path_directory, (err, stat) => {
        if (!err) {
            if (stat.isDirectory()) {
                let deployments: { [key: string]: any } = {}
                if (fs.existsSync(`${path_directory}/deployments.json`)) {
                    deployments = JSON.parse(fs.readFileSync(`${path_directory}/deployments.json`, 'utf8'))
                    fs.unlink(`${path_directory}/deployments.json`, function (err) {
                        if (err) return console.log(err)
                    })
                }
                deployments[chainId] = {
                    ...deployments[chainId],
                    ...deploymentsAddresses,
                }
                fs.writeFile(
                    `${path_directory}/deployments.json`,
                    JSON.stringify(deployments, null, 2),
                    { flag: 'a+' },
                    (err) => {
                        if (err) console.error(err)
                    }
                )
            }
        }
    })
}

exportDeploymentsAddresses('./wxtm-bridge-contracts-typechain/deployments').catch((e) => {
    console.error(e)
    process.exitCode = 1
})
