import { type DeployFunction } from 'hardhat-deploy/types'

import assert from 'assert'
import verify from '../../utils/verify'
import { ethers } from 'hardhat'
import { getDeployments } from '../../wxtm-bridge-contracts-typechain/deployments'

const contractName = 'wXTMBridge'

const deploy: DeployFunction = async (hre) => {
    const { getNamedAccounts, deployments, getChainId } = hre

    // if (hre.network.name !== 'sepolia-testnet') {
    //     console.log(`Deployment script can only run on the Sepolia network. Current network: ${hre.network.name}`)
    //     return
    // }

    const { deploy } = deployments
    const { deployer } = await getNamedAccounts()
    const chainId = Number(await getChainId())
    const deployedContracts = getDeployments(chainId)

    assert(deployer, 'Missing named deployer account')
    assert(deployedContracts.wXTM, `Missing wXTM deployment for chain ${chainId}`)

    console.log(`wXTM: ${deployedContracts.wXTM}`)
    console.log(`Network: ${hre.network.name}`)
    console.log(`Deployer: ${deployer}`)

    const salt = ethers.utils.id('wXTMBridge-v0.0.1')

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
                    args: [deployedContracts.wXTM],
                },
                // onUpgrade: {
                //     methodName: 'initialize',
                //     args: [deployedContracts.wXTM],
                // },
            },
        },
    })

    console.log(
        `wXTMBridge contract deployed to network: ${hre.network.name}, address: ${proxy.address}, wXTM: ${deployedContracts.wXTM}, implementation: ${proxy.implementation}`
    )

    /** @dev Verify Implementation */
    if (proxy.implementation) {
        await verify(hre, proxy.implementation, [])
    }
}

deploy.tags = [contractName]

export default deploy
