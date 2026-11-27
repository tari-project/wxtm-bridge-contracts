import { ethers } from 'ethers'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

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

/** The wXTMController low and high minter Safes deploy/wxtm grants on a new controller. */
export const MINTERS = ['0x7cC835597EADFa3C5A5d9f0B90c0491C289B8Eee', '0xFa2459708A9549C371963a3fCd239dd614E8D52C']

/** Owners and threshold of the Safe at `address`, or undefined when it does not answer as a Safe. */
export async function safeOwners(hre: Pick<HardhatRuntimeEnvironment, 'ethers'>, address: string) {
    const safe = new ethers.Contract(
        address,
        ['function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)'],
        hre.ethers.provider
    )
    try {
        return { owners: (await safe.getOwners()) as string[], threshold: (await safe.getThreshold()).toNumber() }
    } catch (e) {
        if ((e as { code?: string }).code === 'CALL_EXCEPTION') return undefined
        throw e
    }
}

/**
 * The `guardian` named account for this network: the Safe that may pause wXTMBridge and wXTMController (only the
 * admin can unpause). Like the admin, never falls back to the deployer. Must answer as a Safe (not a key, a
 * ProxyAdmin or a token), and neither it nor its owners may be the admin, the deployer or a minter: a compromised
 * key there must not also be the only fast pauser.
 */
export async function getGuardian(hre: Pick<HardhatRuntimeEnvironment, 'getNamedAccounts' | 'network' | 'ethers'>) {
    const { guardian, admin, deployer } = await hre.getNamedAccounts()
    if (!guardian || guardian === ethers.constants.AddressZero) {
        throw new Error(
            `No guardian for network "${hre.network.name}": set namedAccounts.guardian["${hre.network.name}"] in hardhat.config.ts ` +
                `to the Safe that must hold PAUSER_ROLE.`
        )
    }
    // 0xef0100: an EIP-7702 delegated EOA, a key even if its delegate answers like a Safe.
    const delegated = (await hre.ethers.provider.getCode(guardian)).toLowerCase().startsWith('0xef0100')
    const safe = delegated ? undefined : await safeOwners(hre, guardian)
    const forbidden = [admin, deployer, ...MINTERS].filter(Boolean).map((a) => a.toLowerCase())
    if (!safe || [guardian, ...safe.owners].some((a) => forbidden.includes(a.toLowerCase()))) {
        throw new Error(
            `Guardian ${guardian} on "${hre.network.name}" must be a Safe that is not, and is not owned by, ` +
                `the admin, the deployer or a minter.`
        )
    }
    return guardian
}

export const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
export const EIP1967_ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'

export async function slotAddress(hre: Pick<HardhatRuntimeEnvironment, 'ethers'>, address: string, slot: string) {
    return ethers.utils.getAddress(ethers.utils.hexDataSlice(await hre.ethers.provider.getStorageAt(address, slot), 12))
}

async function hasRole(
    hre: Pick<HardhatRuntimeEnvironment, 'ethers'>,
    contract: string,
    role: string,
    account: string
) {
    // Not deployments.read: the recorded ABI may be the pre-upgrade one, without hasRole (wXTMBridge). A reverting
    // call (a pre-upgrade bridge has no hasRole) counts as "no"; any other error (e.g. the RPC) is rethrown.
    const accessControl = new ethers.utils.Interface(['function hasRole(bytes32, address) view returns (bool)'])
    try {
        const result = await hre.ethers.provider.call({
            to: contract,
            data: accessControl.encodeFunctionData('hasRole', [role, account]),
        })
        return result !== '0x' && accessControl.decodeFunctionResult('hasRole', result)[0] === true
    } catch (e) {
        if ((e as { code?: string }).code === 'CALL_EXCEPTION') return false
        throw e
    }
}

/**
 * Fails when the proxy does not run `deployment.implementation`, the guardian lacks PAUSER_ROLE, or the admin lacks
 * DEFAULT_ADMIN_ROLE (without it a paused bridge can never be unpaused).
 */
export async function assertUpgraded(
    hre: Pick<HardhatRuntimeEnvironment, 'network' | 'ethers'>,
    name: string,
    deployment: { address: string; implementation?: string },
    admin: string,
    guardian: string
) {
    const running = await slotAddress(hre, deployment.address, EIP1967_IMPLEMENTATION_SLOT)
    const failed = [
        running.toLowerCase() !== deployment.implementation?.toLowerCase() &&
            `it runs ${running}, not ${deployment.implementation}`,
        !(await hasRole(hre, deployment.address, ethers.utils.id('PAUSER_ROLE'), guardian)) &&
            `guardian ${guardian} lacks PAUSER_ROLE`,
        !(await hasRole(hre, deployment.address, ethers.constants.HashZero, admin)) &&
            `admin ${admin} lacks DEFAULT_ADMIN_ROLE`,
    ].filter(Boolean)
    if (failed.length === 0) return
    throw new Error(
        `${name} ${deployment.address} on "${hre.network.name}" is not upgraded and set up: ${failed.join('; ')}. ` +
            `Upgrade with \`npx hardhat --network ${hre.network.name} upgrade-calldata:wxtm --contract ${name} --deploy-implementation\`; ` +
            `if the proxy is already upgraded and set up, run it with --check to update the records.`
    )
}

/**
 * Refuses a fresh deploy of `name` when the package's deployments.json already lists one for this chain but
 * deployments/<network> has no record of it (hardhat-deploy would create a second one).
 */
export async function assertNotListedElsewhere(
    hre: Pick<HardhatRuntimeEnvironment, 'deployments' | 'network' | 'getChainId'>,
    name: 'wXTM' | 'wXTMBridge' | 'wXTMController'
) {
    const chainId = Number(await hre.getChainId())
    const listed = getDeployments(chainId)
    if (listed[name] && !(await hre.deployments.getOrNull(name))) {
        throw new Error(
            `${name} for chain ${chainId} is listed at ${listed[name]} in wxtm-bridge-contracts-typechain/deployments/` +
                `deployments.json, but deployments/${hre.network.name}/${name}.json does not exist. Import its records ` +
                `(${name}.json, ${name}_Implementation.json, ${name}_Proxy.json), ` +
                `or remove the listing to deploy a new ${name} and repoint its consumers.`
        )
    }
    return { chainId, listed }
}

/**
 * The wXTM to wire `name` to: deployments/<network>/wXTM.json, else the package's deployments.json entry for this
 * chain; fails if both exist and differ. Also refuses a fresh deploy of `name` the package lists (see above).
 */
export async function chainDeployments(
    hre: Pick<HardhatRuntimeEnvironment, 'deployments' | 'network' | 'getChainId'>,
    name: 'wXTMBridge' | 'wXTMController'
) {
    const { chainId, listed } = await assertNotListedElsewhere(hre, name)
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
