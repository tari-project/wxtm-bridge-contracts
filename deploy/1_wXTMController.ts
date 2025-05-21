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
    const deployedContracts = getDeployments(11155111)

    assert(deployer, 'Missing named deployer account')

    console.log(`Network: ${hre.network.name}`)
    console.log(`Deployer: ${deployer}`)

    const salt = ethers.utils.id('wXTMController-deployment_v0.0.1')

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
                    args: [deployer, deployer, deployer],
                },
                onUpgrade: {
                    methodName: 'initializeV11',
                    args: [deployedContracts.wXTM, deployer, deployer, deployer],
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
