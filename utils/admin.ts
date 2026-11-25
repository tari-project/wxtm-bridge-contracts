import { ethers } from 'ethers'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployOptions } from 'hardhat-deploy/types'

/**
 * The `admin` named account for this network: ProxyAdmin owner, DEFAULT_ADMIN_ROLE holder, wXTM owner and
 * LayerZero delegate. Never falls back to the deployer, so whoever runs a deploy does not get admin powers.
 */
export async function getAdmin(hre: Pick<HardhatRuntimeEnvironment, 'getNamedAccounts' | 'network'>) {
    const { admin } = await hre.getNamedAccounts()
    if (!admin || admin === ethers.constants.AddressZero) {
        throw new Error(
            `No admin for network "${hre.network.name}": set namedAccounts.admin["${hre.network.name}"] in hardhat.config.ts ` +
                `to the address that must hold the contract admin powers.`
        )
    }
    return admin
}

/**
 * Fails before deploying when `name` already exists, the deployer is not the admin, and the deploy would upgrade it:
 * the implementation differs from the deployed one. hardhat-deploy would deploy the new implementation from the
 * deployer, then fail to send the upgrade from the admin; a rerun then records the new implementation in
 * deployments/ although the proxy was never upgraded (catchUnknownSigner does not prevent that). `implementation`
 * must be the same contract, args and salt the proxy deploy uses, so this asks the question hardhat-deploy asks.
 */
export async function assertDeployerCanUpgrade(
    hre: Pick<HardhatRuntimeEnvironment, 'deployments' | 'network'>,
    name: string,
    deployer: string,
    admin: string,
    implementation: Omit<DeployOptions, 'from'>
) {
    if (deployer.toLowerCase() === admin.toLowerCase()) return
    const existing = await hre.deployments.getOrNull(name)
    if (!existing) return
    const { differences, address } = await hre.deployments.fetchIfDifferent(`${name}_Implementation`, {
        ...implementation,
        from: deployer,
    })
    const sameImplementation = !address || address.toLowerCase() === existing.implementation?.toLowerCase()
    if (!differences && sameImplementation) return
    throw new Error(
        `${name} is already deployed on "${hre.network.name}" and its admin is ${admin}, not the deployer ${deployer}. ` +
            `Upgrading from here would deploy the implementation but not upgrade the proxy, and record an upgrade ` +
            `that never happened. Run the deploy as the admin, or deploy the implementation and have the admin upgrade.`
    )
}
