import assert from 'assert'

import { type DeployFunction } from 'hardhat-deploy/types'

import { assertUpgraded, chainDeployments, getAdmin, getGuardian, implementationOptions } from '../../utils/admin'
import verify from '../../utils/verify'

const contractName = 'wXTMController'

const deploy: DeployFunction = async (hre) => {
    const { getNamedAccounts, deployments } = hre

    const { deploy } = deployments
    const { deployer } = await getNamedAccounts()

    assert(deployer, 'Missing named deployer account')
    const admin = await getAdmin(hre)
    const guardian = await getGuardian(hre)
    // Existing proxies are only checked: upgrades go through upgrade-calldata:wxtm, and deploy() would also deploy a
    // stray ProxyAdmin for the current admin (its CREATE2 address need not match the proxy's real ProxyAdmin).
    const existing = await deployments.getOrNull(contractName)
    if (existing) {
        await assertUpgraded(hre, contractName, existing, admin, guardian)
        console.log(`${contractName} ${existing.address} runs ${existing.implementation} and is set up; nothing to do`)
        return
    }
    const deployedContracts = await chainDeployments(hre, contractName)

    console.log(`Network: ${hre.network.name}`)
    console.log(`Deployer: ${deployer}`)
    console.log(`Admin: ${admin}`)
    console.log(`Guardian: ${guardian}`)

    const implementation = implementationOptions(contractName)

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
                    args: [
                        deployedContracts.wXTM,
                        '0x7cC835597EADFa3C5A5d9f0B90c0491C289B8Eee',
                        '0xFa2459708A9549C371963a3fCd239dd614E8D52C',
                        admin,
                        guardian,
                    ],
                },
            },
        },
    })
    await assertUpgraded(hre, contractName, proxy, admin, guardian)

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
