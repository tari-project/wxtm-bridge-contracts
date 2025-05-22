import { type DeployFunction } from 'hardhat-deploy/types'

import assert from 'assert'
import verify from '../utils/verify'
import { ethers } from 'hardhat'
import { getDeployments } from '../wxtm-bridge-contracts-typechain/deployments'

const contractName = 'wXTMController'

const deploy: DeployFunction = async (hre) => {
    const { getNamedAccounts, deployments } = hre

    const { deploy } = deployments
    const { deployer } = await getNamedAccounts()
    const deployedContracts = getDeployments(1)

    assert(deployer, 'Missing named deployer account')

    console.log(`Network: ${hre.network.name}`)
    console.log(`Deployer: ${deployer}`)

    const salt = ethers.utils.id('wXTMController-v0.0.1')

    const proxy = await deploy(contractName, {
        from: deployer,
        args: [],
        deterministicDeployment: salt,
        log: true,
        waitConfirmations: 5,
        skipIfAlreadyDeployed: false,
        proxy: {
            proxyContract: 'OpenZeppelinTransparentProxy',
            owner: deployer,
            execute: {
                init: {
                    methodName: 'initialize',
                    args: [
                        deployedContracts.wXTM,
                        '0x7cC835597EADFa3C5A5d9f0B90c0491C289B8Eee',
                        '0xFa2459708A9549C371963a3fCd239dd614E8D52C',
                        deployer,
                    ],
                },
                onUpgrade: {
                    methodName: 'initialize',
                    args: [
                        deployedContracts.wXTM,
                        '0x7cC835597EADFa3C5A5d9f0B90c0491C289B8Eee',
                        '0xFa2459708A9549C371963a3fCd239dd614E8D52C',
                        deployer,
                    ],
                },
            },
        },
    })

    console.log(
        `wXTMController proxy contract deployed to network: ${hre.network.name}, address: ${proxy.address}, implementation: ${proxy.implementation}`
    )

    /** @dev Verify Implementation */
    if (proxy.implementation) {
        await verify(hre, proxy.implementation, [])
    }
}

deploy.tags = [contractName]

export default deploy
