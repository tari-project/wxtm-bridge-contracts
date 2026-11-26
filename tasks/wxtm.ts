import { ethers } from 'ethers'
import { task, types } from 'hardhat/config'

import { EIP1967_ADMIN_SLOT, assertUpgraded, getAdmin, getGuardian, slotAddress } from '../utils/admin'

// Usage: npx hardhat --network <net> upgrade-calldata:wxtm --contract wXTMController [--implementation 0x..] [--check]
task(
    'upgrade-calldata:wxtm',
    'Print the ProxyAdmin.upgradeAndCall transaction for the admin to sign (sends nothing); --check verifies it ran'
)
    .addParam('contract', 'wXTMController or wXTMBridge', undefined, types.string)
    .addOptionalParam(
        'implementation',
        'New implementation (default: deployments/<network>/<contract>_Implementation.json)',
        undefined,
        types.string
    )
    .addFlag('check', 'Verify the proxy runs the implementation and the guardian has PAUSER_ROLE')
    .setAction(async (args: { contract: string; implementation?: string; check: boolean }, hre) => {
        const admin = await getAdmin(hre)
        const guardian = await getGuardian(hre)
        const setups: { [name: string]: [string, string[]] } = {
            wXTMController: ['function initializeV2(address guardian)', [guardian]],
            wXTMBridge: ['function initializeV2(address admin, address guardian)', [admin, guardian]],
        }
        if (!setups[args.contract]) throw new Error(`--contract must be one of ${Object.keys(setups)}`)
        const proxy = (await hre.deployments.get(args.contract)).address
        const implementation =
            args.implementation ?? (await hre.deployments.get(`${args.contract}_Implementation`)).address
        if ((await hre.ethers.provider.getCode(implementation)) === '0x') {
            throw new Error(`No contract at implementation ${implementation}`)
        }

        if (args.check) {
            await assertUpgraded(hre, args.contract, { address: proxy, implementation }, guardian)
            console.log(`${args.contract} ${proxy} runs ${implementation} and ${guardian} has PAUSER_ROLE`)
            return
        }

        const [signature, setupArgs] = setups[args.contract]
        const setup = new ethers.utils.Interface([signature]).encodeFunctionData('initializeV2', setupArgs)
        const data = new ethers.utils.Interface([
            'function upgradeAndCall(address proxy, address implementation, bytes data)',
        ]).encodeFunctionData('upgradeAndCall', [proxy, implementation, setup])
        const proxyAdmin = await slotAddress(hre, proxy, EIP1967_ADMIN_SLOT)
        console.log(`Admin ${admin} sends to ProxyAdmin ${proxyAdmin} (value 0):`)
        console.log(`upgradeAndCall(${proxy}, ${implementation}, ${setup})`)
        console.log(`calldata: ${data}`)
    })
