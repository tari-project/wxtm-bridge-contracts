import { expect } from 'chai'
import { ethers } from 'ethers'
import hre, { artifacts, deployments } from 'hardhat'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

import { upgradeCalldata, upgradeCalldataAction } from '../../tasks/wxtm'

const refusal = (promise: Promise<unknown>) =>
    promise.then(
        () => undefined,
        (e: Error) => e.message
    )

describe('upgrade-calldata:wxtm', function () {
    const PROXY = '0x810be828EFA687667B289C488A57a7B48Fb4523E'
    const IMPLEMENTATION = '0x2222222222222222222222222222222222222222'
    const ADMIN = '0xe178b64Acf345A48a5a9FD34CA4F8d9cbA864fCB'
    const GUARDIAN = '0x4444444444444444444444444444444444444444'
    const proxyAdmin = new ethers.utils.Interface([
        'function upgradeAndCall(address proxy, address implementation, bytes data)',
    ])

    for (const [name, expected] of [
        ['wXTMBridge', [ADMIN, GUARDIAN]],
        ['wXTMController', [GUARDIAN]],
    ] as const) {
        it(`builds upgradeAndCall with ${name}.initializeV2(${expected.length === 2 ? 'admin, ' : ''}guardian)`, async function () {
            const { data } = upgradeCalldata(name, PROXY, IMPLEMENTATION, ADMIN, GUARDIAN)
            const [proxy, implementation, setup] = proxyAdmin.decodeFunctionData('upgradeAndCall', data)
            expect([proxy, implementation]).to.deep.equal([PROXY, IMPLEMENTATION])

            // Decoded against the compiled contract, so a signature drift would fail here.
            const compiled = new ethers.utils.Interface((await artifacts.readArtifact(name)).abi)
            const call = compiled.parseTransaction({ data: setup })
            expect(call.name).to.equal('initializeV2')
            expect(call.args.map(String)).to.deep.equal([...expected])
        })
    }

    it('upgrades a proxy on the hardhat network: refusals, upgradeAndCall, --check records it', async function () {
        await deployments.fixture(['none']) // empty in-memory deployments
        const [deployer, admin, stranger] = await hre.ethers.getSigners()
        const from = deployer.address
        // Any contract stands in for the guardian Safe; wTARIBridge stands in for the old implementation.
        const guardian = (await deployments.deploy('GuardianStandIn', { contract: 'wTARIBridge', from })).address
        await deployments.deploy('wXTMBridge', {
            contract: 'wTARIBridge',
            from,
            proxy: { proxyContract: 'OpenZeppelinTransparentProxy', owner: admin.address },
        })
        const before = await deployments.get('wXTMBridge')

        const withAccounts = (configuredAdmin: string, configuredGuardian: string) =>
            Object.assign(Object.create(hre), {
                getNamedAccounts: async () => ({
                    deployer: from,
                    admin: configuredAdmin,
                    guardian: configuredGuardian,
                }),
            }) as HardhatRuntimeEnvironment
        const run = (
            flags: { deployImplementation?: boolean; check?: boolean },
            configuredAdmin = admin.address,
            configuredGuardian = guardian
        ) =>
            upgradeCalldataAction(
                { contract: 'wXTMBridge', deployImplementation: false, check: false, ...flags },
                withAccounts(configuredAdmin, configuredGuardian)
            )

        expect(await refusal(run({}, stranger.address))).to.match(/owned by 0x.*, not the configured admin/)
        expect(await refusal(run({}))).to.match(/is not the compiled wXTMBridge: pass --deploy-implementation/)

        const tx = await run({ deployImplementation: true })
        expect(await refusal(run({ check: true }))).to.match(/not upgraded and set up/)

        await (await admin.sendTransaction({ to: tx?.to, data: tx?.data })).wait()
        expect(await refusal(run({}))).to.match(/already runs 0x.* and is set up/)
        // Set up already, but with another guardian than configured: name the failed check, print nothing.
        const otherGuardian = (await deployments.deploy('OtherGuardian', { contract: 'wTARIBridge', from })).address
        expect(await refusal(run({}, admin.address, otherGuardian))).to.match(/guardian 0x.* lacks PAUSER_ROLE/)
        await run({ check: true })

        const after = await deployments.get('wXTMBridge')
        const implementation = (await deployments.get('wXTMBridge_Implementation')).address
        expect(after.implementation).to.equal(implementation).and.not.equal(before.implementation)
        expect(after.abi.map((fragment) => fragment.name)).to.include.members(['initializeV2', 'pause', 'PAUSER_ROLE'])
        expect([after.address, after.args, after.receipt]).to.deep.equal([before.address, before.args, before.receipt])
    })
})
