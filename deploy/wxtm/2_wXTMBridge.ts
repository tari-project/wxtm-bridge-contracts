import assert from 'assert'

import { type DeployFunction } from 'hardhat-deploy/types'

import {
    assertDeployerCanUpgrade,
    assertUpgraded,
    chainDeployments,
    getAdmin,
    getGuardian,
    implementationOptions,
} from '../../utils/admin'
import verify from '../../utils/verify'

const contractName = 'wXTMBridge'

const deploy: DeployFunction = async (hre) => {
    const { getNamedAccounts, deployments } = hre

    // if (hre.network.name !== 'sepolia-testnet') {
    //     console.log(`Deployment script can only run on the Sepolia network. Current network: ${hre.network.name}`)
    //     return
    // }

    const { deploy } = deployments
    const { deployer } = await getNamedAccounts()

    assert(deployer, 'Missing named deployer account')
    const admin = await getAdmin(hre)
    const guardian = await getGuardian(hre)
    const deployedContracts = await chainDeployments(hre, contractName)

    console.log(`wXTM: ${deployedContracts.wXTM}`)
    console.log(`Network: ${hre.network.name}`)
    console.log(`Deployer: ${deployer}`)
    console.log(`Admin: ${admin}`)
    console.log(`Guardian: ${guardian}`)

    const implementation = implementationOptions(contractName)
    await assertDeployerCanUpgrade(hre, contractName, deployer, admin, implementation)

    const proxy = await deploy(contractName, {
        from: deployer,
        args: implementation.args,
        deterministicDeployment: implementation.deterministicDeployment,
        log: true,
        waitConfirmations: 5,
        skipIfAlreadyDeployed: false,
        proxy: {
            proxyContract: 'OpenZeppelinTransparentProxy',
            owner: admin,
            execute: {
                init: {
                    methodName: 'initialize',
                    args: [deployedContracts.wXTM, admin, guardian],
                },
                // Existing proxies keep their wXTM; this only adds the admin and the guardian.
                onUpgrade: {
                    methodName: 'initializeV2',
                    args: [admin, guardian],
                },
            },
        },
    })
    await assertUpgraded(hre, contractName, proxy, guardian)

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
