import { ethers } from 'ethers'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployOptions } from 'hardhat-deploy/types'

import { getDeployments } from '../wxtm-bridge-contracts-typechain/deployments'

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
 * The `guardian` named account for this network: the Safe that may pause wXTMBridge and wXTMController (only the
 * admin can unpause). Like the admin, never falls back to the deployer; must be a contract (the contracts refuse an
 * EOA guardian too) other than the admin and the deployer.
 */
export async function getGuardian(hre: Pick<HardhatRuntimeEnvironment, 'getNamedAccounts' | 'network' | 'ethers'>) {
    const { guardian, admin, deployer } = await hre.getNamedAccounts()
    if (!guardian || guardian === ethers.constants.AddressZero) {
        throw new Error(
            `No guardian for network "${hre.network.name}": set namedAccounts.guardian["${hre.network.name}"] in hardhat.config.ts ` +
                `to the Safe that must hold PAUSER_ROLE.`
        )
    }
    const isAdminOrDeployer = [admin, deployer].some((a) => a?.toLowerCase() === guardian.toLowerCase())
    // No code: an EOA; 0xef0100: an EIP-7702 delegated EOA. Either is a key, not a Safe.
    const code = await hre.ethers.provider.getCode(guardian)
    if (isAdminOrDeployer || code === '0x' || code.toLowerCase().startsWith('0xef0100')) {
        throw new Error(`Guardian ${guardian} on "${hre.network.name}" must be a Safe, not the admin or the deployer.`)
    }
    return guardian
}

export const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
export const EIP1967_ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'

export async function slotAddress(hre: Pick<HardhatRuntimeEnvironment, 'ethers'>, address: string, slot: string) {
    return ethers.utils.getAddress(ethers.utils.hexDataSlice(await hre.ethers.provider.getStorageAt(address, slot), 12))
}

/**
 * Fails before deploying when `name` already exists and the deploy would upgrade it (the implementation differs from
 * the deployed one), but hardhat-deploy cannot send that upgrade:
 * - the deployer is not the admin: hardhat-deploy would deploy the new implementation from the deployer, then fail
 *   to send the upgrade from the admin; a rerun then records the new implementation in deployments/ although the
 *   proxy was never upgraded (catchUnknownSigner does not prevent that);
 * - the proxy's EIP-1967 admin is not DefaultProxyAdmin: hardhat-deploy deploys the implementation, then throws.
 * `implementation` must be the same contract, args and salt the proxy deploy uses, so this asks the question
 * hardhat-deploy asks.
 */
export async function assertDeployerCanUpgrade(
    hre: Pick<HardhatRuntimeEnvironment, 'deployments' | 'network' | 'ethers'>,
    name: string,
    deployer: string,
    admin: string,
    implementation: Omit<DeployOptions, 'from'>
) {
    const existing = await hre.deployments.getOrNull(name)
    if (!existing) return
    const { differences, address } = await hre.deployments.fetchIfDifferent(`${name}_Implementation`, {
        ...implementation,
        from: deployer,
    })
    const sameImplementation = !address || address.toLowerCase() === existing.implementation?.toLowerCase()
    if (!differences && sameImplementation) return
    const manualUpgrade =
        `deploy the implementation and have the owner of the proxy's ProxyAdmin (EIP-1967 admin slot) call ` +
        `upgradeAndCall with the script's onUpgrade calldata (initializeV2 for wXTMBridge and wXTMController). ` +
        `Never upgrade() followed by a separate call: initializeV2 only accepts the ProxyAdmin as caller, so the ` +
        `setup would still need upgradeAndCall to the same implementation.`
    if (deployer.toLowerCase() !== admin.toLowerCase()) {
        throw new Error(
            `${name} is already deployed on "${hre.network.name}" and its admin is ${admin}, not the deployer ${deployer}. ` +
                `Upgrading from here would deploy the implementation but not upgrade the proxy, and record an upgrade ` +
                `that never happened. Run the deploy as the admin, or ${manualUpgrade}`
        )
    }
    const proxyAdmin = await slotAddress(hre, existing.address, EIP1967_ADMIN_SLOT)
    const defaultProxyAdmin = await hre.deployments.getOrNull('DefaultProxyAdmin')
    if (proxyAdmin.toLowerCase() !== defaultProxyAdmin?.address.toLowerCase()) {
        throw new Error(
            `${name} on "${hre.network.name}" is administered by ${proxyAdmin}, not DefaultProxyAdmin ` +
                `${defaultProxyAdmin?.address}, so hardhat-deploy cannot upgrade it. Instead, ${manualUpgrade}`
        )
    }
}

/**
 * Fails after a deploy when the proxy does not run the implementation hardhat-deploy recorded, or the guardian lacks
 * PAUSER_ROLE: hardhat-deploy saves a new implementation without sending any upgrade when it was already deployed
 * (a rerun, or the CREATE2 address already has code).
 */
export async function assertUpgraded(
    hre: Pick<HardhatRuntimeEnvironment, 'network' | 'ethers'>,
    name: string,
    deployment: { address: string; implementation?: string },
    guardian: string
) {
    const running = await slotAddress(hre, deployment.address, EIP1967_IMPLEMENTATION_SLOT)
    // Not deployments.read: the recorded ABI may be the pre-upgrade one, without hasRole (wXTMBridge), and a
    // pre-upgrade bridge reverts on hasRole, which counts as "no".
    const accessControl = new ethers.utils.Interface(['function hasRole(bytes32, address) view returns (bool)'])
    const result = await hre.ethers.provider
        .call({
            to: deployment.address,
            data: accessControl.encodeFunctionData('hasRole', [ethers.utils.id('PAUSER_ROLE'), guardian]),
        })
        .catch(() => '0x')
    const guardianCanPause = result !== '0x' && accessControl.decodeFunctionResult('hasRole', result)[0] === true
    if (running.toLowerCase() === deployment.implementation?.toLowerCase() && guardianCanPause) return
    throw new Error(
        `${name} on "${hre.network.name}" runs ${running}, recorded ${deployment.implementation}; guardian ${guardian} ` +
            `has PAUSER_ROLE: ${guardianCanPause}. deployments/${hre.network.name}/${name}.json records an upgrade ` +
            `that did not happen: have the owner of the proxy's ProxyAdmin (EIP-1967 admin slot) call upgradeAndCall ` +
            `with the implementation and the initializeV2 calldata.`
    )
}

/**
 * The wXTM to wire `name` to: deployments/<network>/wXTM.json, else the package's deployments.json entry for this
 * chain; fails if both exist and differ. Also refuses a fresh deploy of `name` when the package already lists one
 * for the chain but deployments/<network> has no record of it (hardhat-deploy would create a second one).
 */
export async function chainDeployments(
    hre: Pick<HardhatRuntimeEnvironment, 'deployments' | 'network' | 'getChainId'>,
    name: 'wXTMBridge' | 'wXTMController'
) {
    const chainId = Number(await hre.getChainId())
    const listed = getDeployments(chainId)
    if (listed[name] && !(await hre.deployments.getOrNull(name))) {
        throw new Error(
            `${name} for chain ${chainId} is listed at ${listed[name]} in wxtm-bridge-contracts-typechain/deployments/` +
                `deployments.json, but deployments/${hre.network.name}/${name}.json does not exist. Import that record, ` +
                `or remove the listing to deploy a new ${name} and repoint its consumers.`
        )
    }
    const local = (await hre.deployments.getOrNull('wXTM'))?.address
    if (local && listed.wXTM && local.toLowerCase() !== listed.wXTM.toLowerCase()) {
        throw new Error(
            `wXTM on chain ${chainId} is ${local} in deployments/${hre.network.name} but ${listed.wXTM} in ` +
                `wxtm-bridge-contracts-typechain/deployments: reconcile them first.`
        )
    }
    const wXTM = local ?? listed.wXTM
    if (!wXTM) throw new Error(`No wXTM for chain ${chainId} in deployments/${hre.network.name} or the package`)
    return { wXTM }
}

/** The implementation deploy that hardhat-deploy derives from the proxy deploys in deploy/wxtm. */
export function implementationOptions(name: 'wXTMBridge' | 'wXTMController') {
    return { contract: name, args: [], deterministicDeployment: ethers.utils.id(`${name}-v0.0.1`) }
}
