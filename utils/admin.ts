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

/** The `lowMinter` and `highMinter` named accounts for this network: the wXTMController minters. No default. */
export async function getMinters(hre: Pick<HardhatRuntimeEnvironment, 'getNamedAccounts' | 'network'>) {
    const { lowMinter, highMinter } = await hre.getNamedAccounts()
    if (!lowMinter || !highMinter || [lowMinter, highMinter].includes(ethers.constants.AddressZero)) {
        throw new Error(
            `No minters for network "${hre.network.name}": set namedAccounts.lowMinter["${hre.network.name}"] and ` +
                `namedAccounts.highMinter["${hre.network.name}"] in hardhat.config.ts.`
        )
    }
    return [lowMinter, highMinter]
}

// Safe's guard storage slot: keccak256("guard_manager.guard.address").
const SAFE_GUARD_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8'
const SAFE_MODULES_SENTINEL = '0x0000000000000000000000000000000000000001'

/** Owners, threshold, enabled modules and guard of the Safe at `address`; undefined when it does not answer as one. */
export async function safeInfo(hre: Pick<HardhatRuntimeEnvironment, 'ethers'>, address: string) {
    const safe = new ethers.Contract(
        address,
        [
            'function getOwners() view returns (address[])',
            'function getThreshold() view returns (uint256)',
            'function getModulesPaginated(address start, uint256 pageSize) view returns (address[], address)',
        ],
        hre.ethers.provider
    )
    try {
        return {
            owners: (await safe.getOwners()) as string[],
            threshold: (await safe.getThreshold()).toNumber(),
            modules: (await safe.getModulesPaginated(SAFE_MODULES_SENTINEL, 10))[0] as string[],
            guard: await slotAddress(hre, address, SAFE_GUARD_SLOT),
        }
    } catch (e) {
        if ((e as { code?: string }).code === 'CALL_EXCEPTION') return undefined
        throw e
    }
}

/**
 * The `guardian` named account for this network: the Safe that may pause wXTMBridge and wXTMController (only the
 * admin can unpause). Like the admin, never falls back to the deployer. Must answer as a Safe (not a key, a
 * ProxyAdmin or a token) whose only control is its owners, and those must be plain keys (the on-call humans): no
 * modules, no guard, no contract or EIP-7702 delegated owners. Neither it nor its owners may be the admin, the
 * deployer or a minter: a compromised key there must not also be the only fast pauser. Owners can change later, so
 * this is a deploy-time check.
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
    const safe = delegated ? undefined : await safeInfo(hre, guardian)
    const forbidden = [admin, deployer, ...(await getMinters(hre))].filter(Boolean).map((a) => a.toLowerCase())
    const ownerCode = await Promise.all((safe?.owners ?? []).map((owner) => hre.ethers.provider.getCode(owner)))
    if (
        !safe ||
        [guardian, ...safe.owners].some((a) => forbidden.includes(a.toLowerCase())) ||
        safe.modules.length > 0 ||
        safe.guard !== ethers.constants.AddressZero ||
        ownerCode.some((code) => code !== '0x')
    ) {
        throw new Error(
            `Guardian ${guardian} on "${hre.network.name}" must be a Safe with plain-key owners, no modules and no ` +
                `guard, that is not, and is not owned by, the admin, the deployer or a minter.`
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
