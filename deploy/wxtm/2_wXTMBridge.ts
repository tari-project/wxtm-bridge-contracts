import assert from 'assert'

import { ethers } from 'hardhat'
import { type DeployFunction } from 'hardhat-deploy/types'

import { assertDeployerCanUpgrade, getAdmin } from '../../utils/admin'
import verify from '../../utils/verify'
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
    const admin = await getAdmin(hre)

    console.log(`wXTM: ${deployedContracts.wXTM}`)
    console.log(`Network: ${hre.network.name}`)
    console.log(`Deployer: ${deployer}`)
    console.log(`Admin: ${admin}`)

    const salt = ethers.utils.id('wXTMBridge-v0.0.1')
    await assertDeployerCanUpgrade(hre, contractName, deployer, admin, {
        contract: contractName,
        args: [],
        deterministicDeployment: salt,
    })

    const proxy = await deploy(contractName, {
        from: deployer,
        args: [],
        deterministicDeployment: salt,
        log: true,
        waitConfirmations: 5,
        skipIfAlreadyDeployed: false,
        proxy: {
            proxyContract: 'OpenZeppelinTransparentProxy',
            owner: admin,
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
