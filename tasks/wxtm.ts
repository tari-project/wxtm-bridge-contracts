import { ethers } from 'ethers'
import { task, types } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { mergeABIs } from 'hardhat-deploy/dist/src/utils'

import {
    EIP1967_ADMIN_SLOT,
    EIP1967_IMPLEMENTATION_SLOT,
    assertUpgraded,
    getAdmin,
    getGuardian,
    implementationOptions,
    slotAddress,
} from '../utils/admin'
import verify from '../utils/verify'

type Name = 'wXTMBridge' | 'wXTMController'

/** ProxyAdmin.upgradeAndCall calldata that upgrades `proxy` to `implementation` and runs initializeV2. */
export function upgradeCalldata(name: Name, proxy: string, implementation: string, admin: string, guardian: string) {
    const [signature, args] = {
        wXTMController: ['function initializeV2(address guardian)', [guardian]],
        wXTMBridge: ['function initializeV2(address admin, address guardian)', [admin, guardian]],
    }[name] as [string, string[]]
    const setup = new ethers.utils.Interface([signature]).encodeFunctionData('initializeV2', args)
    const data = new ethers.utils.Interface([
        'function upgradeAndCall(address proxy, address implementation, bytes data)',
    ]).encodeFunctionData('upgradeAndCall', [proxy, implementation, setup])
    return { setup, data }
}

type Args = { contract: string; deployImplementation: boolean; check: boolean }

// OpenZeppelin v5 Initializable's ERC-7201 slot (uint64 _initialized in the low bytes), and the reinitializer version
// initializeV2 sets.
export const INITIALIZABLE_SLOT = '0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00'
export const SETUP_VERSION: { [name in Name]: bigint } = { wXTMBridge: 102n, wXTMController: 12n }

/**
 * The upgrade-calldata:wxtm action; returns the transaction it prints (print mode). Exported so a test can run it
 * with its own named accounts.
 */
export async function upgradeCalldataAction(args: Args, hre: HardhatRuntimeEnvironment) {
    if (!['wXTMController', 'wXTMBridge'].includes(args.contract)) {
        throw new Error('--contract must be wXTMController or wXTMBridge')
    }
    const name = args.contract as Name
    const admin = await getAdmin(hre)
    const guardian = await getGuardian(hre)
    const proxy = await hre.deployments.get(name)
    const proxyAdmin = await slotAddress(hre, proxy.address, EIP1967_ADMIN_SLOT)
    const owner: string = await new ethers.Contract(
        proxyAdmin,
        ['function owner() view returns (address)'],
        hre.ethers.provider
    ).owner()
    if (!args.check && owner.toLowerCase() !== admin.toLowerCase()) {
        throw new Error(
            `ProxyAdmin ${proxyAdmin} of ${name} is owned by ${owner}, not the configured admin ${admin}: ` +
                `transfer its ownership to the admin or fix namedAccounts.admin before signing anything.`
        )
    }
    const running = await slotAddress(hre, proxy.address, EIP1967_IMPLEMENTATION_SLOT)
    if (!args.check) {
        // Once initializeV2 has run, another upgradeAndCall with it is certain to revert, whatever the proxy runs:
        // refuse before deploying anything, naming the failed checks if any.
        const slot = await hre.ethers.provider.getStorageAt(proxy.address, INITIALIZABLE_SLOT)
        if (BigInt(slot) % 2n ** 64n >= SETUP_VERSION[name]) {
            await assertUpgraded(hre, name, { address: proxy.address, implementation: running }, admin, guardian)
            throw new Error(`${name} ${proxy.address} already runs ${running} and is set up`)
        }
    }
    // Always the CREATE2 implementation deploy/wxtm would use, so the records match what the scripts compute.
    const { deployer } = await hre.getNamedAccounts()
    const { deterministicDeployment: salt, ...options } = implementationOptions(name)
    const create2 = await hre.deployments.deterministic(`${name}_Implementation`, {
        ...options,
        salt,
        from: deployer,
        log: true,
        waitConfirmations: hre.network.live ? 5 : 1,
    })
    if (args.deployImplementation) {
        // deploy() records it as <name>_Implementation; only --check may, once the proxy runs it.
        const previous = await hre.deployments.getOrNull(`${name}_Implementation`)
        await create2.deploy()
        if (previous) await hre.deployments.save(`${name}_Implementation`, previous)
        else await hre.deployments.delete(`${name}_Implementation`)
        await verify(hre, create2.address, [])
    }
    const implementation = create2.address
    const recorded = (await hre.deployments.get(`${name}_Implementation`)).address
    const artifact = await hre.deployments.getExtendedArtifact(name)
    const code = await hre.ethers.provider.getCode(implementation)
    if (code.toLowerCase() !== artifact.deployedBytecode?.toLowerCase()) {
        throw new Error(`${implementation} is not the compiled ${name}: pass --deploy-implementation`)
    }

    if (args.check) {
        await assertUpgraded(hre, name, { address: proxy.address, implementation }, admin, guardian)
        // Record the upgrade the way hardhat-deploy would have, so later deploys and --check see it.
        const proxyAbi = (await hre.deployments.get(`${name}_Proxy`)).abi
        const abi = mergeABIs([proxyAbi, artifact.abi], { check: false, skipSupportsInterface: true })
            .filter((fragment) => fragment.type !== 'constructor')
            .concat(proxyAbi.filter((fragment) => fragment.type === 'constructor'))
        if (implementation.toLowerCase() !== recorded.toLowerCase()) {
            await hre.deployments.save(`${name}_Implementation`, { ...artifact, address: implementation })
        }
        await hre.deployments.save(name, { ...proxy, abi, implementation })
        console.log(`${name} ${proxy.address} runs ${implementation} and is set up; recorded`)
        return
    }

    // The proxy may already run it after a plain upgrade() without the setup: upgradeAndCall finishes that.
    const { setup, data } = upgradeCalldata(name, proxy.address, implementation, admin, guardian)
    console.log(`${name} ${proxy.address} runs ${running}`)
    console.log(`ProxyAdmin owner ${owner} sends to ProxyAdmin ${proxyAdmin} (value 0):`)
    console.log(`upgradeAndCall(${proxy.address}, ${implementation}, ${setup})`)
    console.log(`calldata: ${data}`)
    return { from: owner, to: proxyAdmin, data }
}

// Manual upgrade (sends no upgrade itself), npx hardhat --network <net> upgrade-calldata:wxtm --contract <name>:
// 1. --deploy-implementation  2. the ProxyAdmin owner sends the printed transaction  3. --check (records it)
task(
    'upgrade-calldata:wxtm',
    'Print the ProxyAdmin.upgradeAndCall transaction for the admin to sign; --check verifies and records it'
)
    .addParam('contract', 'wXTMController or wXTMBridge', undefined, types.string)
    .addFlag('deployImplementation', 'First deploy the CREATE2 implementation from the deployer, as deploy/wxtm would')
    .addFlag(
        'check',
        'Verify the proxy runs the implementation and admin and guardian hold their roles, then record it'
    )
    .setAction(upgradeCalldataAction)
