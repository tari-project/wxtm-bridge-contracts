import assert from 'assert'

import { ethers } from 'hardhat'
import { type DeployFunction } from 'hardhat-deploy/types'

import { assertDeployerCanUpgrade, getAdmin, getGuardian } from '../../utils/admin'
import verify from '../../utils/verify'
import { getDeployments } from '../../wxtm-bridge-contracts-typechain/deployments'

const contractName = 'wXTMController'

const deploy: DeployFunction = async (hre) => {
    const { getNamedAccounts, deployments } = hre

    const { deploy } = deployments
    const { deployer } = await getNamedAccounts()
    const deployedContracts = getDeployments(1)

    assert(deployer, 'Missing named deployer account')
    const admin = await getAdmin(hre)
    const guardian = await getGuardian(hre)

    console.log(`Network: ${hre.network.name}`)
    console.log(`Deployer: ${deployer}`)
    console.log(`Admin: ${admin}`)
    console.log(`Guardian: ${guardian}`)

    const salt = ethers.utils.id('wXTMController-v0.0.1')
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
                    args: [
                        deployedContracts.wXTM,
                        '0x7cC835597EADFa3C5A5d9f0B90c0491C289B8Eee',
                        '0xFa2459708A9549C371963a3fCd239dd614E8D52C',
                        admin,
                        guardian,
                    ],
                },
                // Existing proxies keep their minters and admin; this only grants PAUSER_ROLE to the guardian.
                onUpgrade: {
                    methodName: 'initializeV2',
                    args: [guardian],
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
