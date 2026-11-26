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

type Args = { contract: string; implementation?: string; deployImplementation: boolean; check: boolean }

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
    if (args.deployImplementation) {
        const { deployer } = await hre.getNamedAccounts()
        await hre.deployments.deploy(`${name}_Implementation`, {
            ...implementationOptions(name),
            from: deployer,
            log: true,
            waitConfirmations: hre.network.live ? 5 : 1,
        })
    }
    const recorded = (await hre.deployments.get(`${name}_Implementation`)).address
    const implementation = args.implementation ?? recorded
    const artifact = await hre.deployments.getExtendedArtifact(name)
    const code = await hre.ethers.provider.getCode(implementation)
    if (code.toLowerCase() !== artifact.deployedBytecode?.toLowerCase()) {
        throw new Error(
            `${implementation} is not the compiled ${name}: pass --deploy-implementation or the right --implementation`
        )
    }
    const upgraded = await assertUpgraded(hre, name, { address: proxy.address, implementation }, admin, guardian).then(
        () => true,
        (e: Error) => (args.check ? Promise.reject(e) : false)
    )

    if (args.check) {
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

    if (upgraded) throw new Error(`${name} ${proxy.address} already runs ${implementation} and is set up`)
    // The proxy may already run it after a plain upgrade() without the setup: upgradeAndCall finishes that.
    const running = await slotAddress(hre, proxy.address, EIP1967_IMPLEMENTATION_SLOT)
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
    .addOptionalParam(
        'implementation',
        'New implementation (default: deployments/<network>/<contract>_Implementation.json)',
        undefined,
        types.string
    )
    .addFlag('deployImplementation', 'First deploy the implementation from the deployer, as deploy/wxtm would')
    .addFlag(
        'check',
        'Verify the proxy runs the implementation and admin and guardian hold their roles, then record it'
    )
    .setAction(upgradeCalldataAction)
