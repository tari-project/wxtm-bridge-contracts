import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { expect } from 'chai'
import { ethers } from 'ethers'
import hre, { artifacts, deployments } from 'hardhat'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

import { INITIALIZABLE_SLOT, SETUP_VERSION, upgradeCalldata, upgradeCalldataAction } from '../../tasks/wxtm'
import { implementationOptions } from '../../utils/admin'

import { deploySafeMock } from './safeMock'

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

    describe('on the hardhat network', function () {
        let from: string
        let admin: SignerWithAddress
        let stranger: SignerWithAddress
        let guardian: string

        beforeEach(async function () {
            await deployments.fixture(['none']) // empty in-memory deployments
            const [deployer, ...others] = await hre.ethers.getSigners()
            ;[admin, stranger] = others
            from = deployer.address
            guardian = await deploySafeMock(deployer, ['0x7777777777777777777777777777777777777777'])
        })

        const run = (
            contract: 'wXTMBridge' | 'wXTMController',
            flags: { deployImplementation?: boolean; check?: boolean },
            configured: { admin?: string; guardian?: string } = {}
        ) =>
            upgradeCalldataAction(
                { contract, deployImplementation: false, check: false, ...flags },
                Object.assign(Object.create(hre), {
                    getNamedAccounts: async () => ({
                        // Mainnet's minters; any addresses other than the guardian's owners.
                        lowMinter: '0x7cC835597EADFa3C5A5d9f0B90c0491C289B8Eee',
                        highMinter: '0xFa2459708A9549C371963a3fCd239dd614E8D52C',
                        deployer: from,
                        admin: configured.admin ?? admin.address,
                        guardian: configured.guardian ?? guardian,
                    }),
                }) as HardhatRuntimeEnvironment
            )
        const initializedVersion = async (proxy: string) =>
            BigInt(await hre.ethers.provider.getStorageAt(proxy, INITIALIZABLE_SLOT)) % 2n ** 64n
        const send = async (tx?: { to: string; data: string }) =>
            (await admin.sendTransaction({ to: tx?.to, data: tx?.data })).wait()

        it('refuses before deploying when a record of the proxy is missing', async function () {
            await deployments.deploy('wXTMBridge', {
                contract: 'wTARIBridge',
                from,
                proxy: { proxyContract: 'OpenZeppelinTransparentProxy', owner: admin.address },
            })
            await deployments.delete('wXTMBridge_Implementation')
            await deployments.delete('wXTMBridge_Proxy')
            const nonce = await hre.ethers.provider.getTransactionCount(from)
            expect(await refusal(run('wXTMBridge', { deployImplementation: true }))).to.match(
                /Missing deployments\/hardhat\/wXTMBridge_Implementation.json, deployments\/hardhat\/wXTMBridge_Proxy.json/
            )
            expect(await hre.ethers.provider.getTransactionCount(from)).to.equal(nonce)
        })

        it('wXTMBridge: refusals, upgradeAndCall, --check records it, a set-up proxy is refused', async function () {
            // wTARIBridge stands in for the old implementation.
            await deployments.deploy('wXTMBridge', {
                contract: 'wTARIBridge',
                from,
                proxy: { proxyContract: 'OpenZeppelinTransparentProxy', owner: admin.address },
            })
            const before = await deployments.get('wXTMBridge')
            const recordedBefore = (await deployments.get('wXTMBridge_Implementation')).address

            expect(await refusal(run('wXTMBridge', {}, { admin: stranger.address }))).to.match(
                /owned by 0x.*, not the configured admin/
            )
            expect(await refusal(run('wXTMBridge', {}))).to.match(/is not the compiled wXTMBridge/)

            const tx = await run('wXTMBridge', { deployImplementation: true })
            // What a second person reproduces: the printed init-code hash, factory and salt give the implementation.
            const { factory, salt, initCodeHash } = tx ?? {}
            expect(initCodeHash).to.equal(ethers.utils.keccak256((await artifacts.readArtifact('wXTMBridge')).bytecode))
            expect(ethers.utils.getCreate2Address(factory ?? '', salt ?? '', initCodeHash ?? '')).to.equal(
                tx?.implementation
            )
            expect(await hre.ethers.provider.getCode(tx?.implementation ?? '')).to.not.equal('0x')
            expect(tx?.commit).to.match(/^[0-9a-f]{40}$/)
            // Not recorded until the proxy runs it.
            expect((await deployments.get('wXTMBridge_Implementation')).address).to.equal(recordedBefore)
            expect(await refusal(run('wXTMBridge', { check: true }))).to.match(/not upgraded and set up/)

            await send(tx)
            expect(await initializedVersion(before.address)).to.equal(SETUP_VERSION.wXTMBridge)
            expect(await refusal(run('wXTMBridge', {}))).to.match(/already runs 0x.* and is set up/)
            // Set up already, but with another guardian than configured: name the failed check, print nothing.
            const otherGuardian = await deploySafeMock(admin, ['0x7777777777777777777777777777777777777777'])
            expect(await refusal(run('wXTMBridge', {}, { guardian: otherGuardian }))).to.match(
                /guardian 0x.* lacks PAUSER_ROLE/
            )
            await run('wXTMBridge', { check: true })

            const after = await deployments.get('wXTMBridge')
            const implementation = (await deployments.get('wXTMBridge_Implementation')).address
            expect(after.implementation).to.equal(implementation).and.not.equal(before.implementation)
            expect(after.abi.map((fragment) => fragment.name)).to.include.members([
                'initializeV2',
                'pause',
                'PAUSER_ROLE',
            ])
            expect([after.address, after.args, after.receipt]).to.deep.equal([
                before.address,
                before.args,
                before.receipt,
            ])

            // A set-up proxy running another implementation (as after a source change) is refused before anything
            // is deployed.
            const other = (await deployments.deploy('OtherBridgeImplementation', { contract: 'wXTMBridge', from }))
                .address
            await deployments.execute('DefaultProxyAdmin', { from: admin.address }, 'upgrade', before.address, other)
            const nonce = await hre.ethers.provider.getTransactionCount(from)
            expect(await refusal(run('wXTMBridge', { deployImplementation: true }))).to.match(
                /already runs 0x.* and is set up/
            )
            expect(await hre.ethers.provider.getTransactionCount(from)).to.equal(nonce)
        })

        it('wXTMController: a plain upgrade() without setup is finished by upgradeAndCall', async function () {
            // wTARIController, initialized with the admin, stands in for the old controller.
            const proxy = (
                await deployments.deploy('wXTMController', {
                    contract: 'wTARIController',
                    from,
                    proxy: {
                        proxyContract: 'OpenZeppelinTransparentProxy',
                        owner: admin.address,
                        execute: { init: { methodName: 'initialize', args: [guardian, from, from, admin.address, 0] } },
                    },
                })
            ).address

            await run('wXTMController', { deployImplementation: true })
            const implementation = (
                await deployments.deterministic('wXTMController_Implementation', {
                    ...implementationOptions('wXTMController'),
                    salt: implementationOptions('wXTMController').deterministicDeployment,
                    from,
                })
            ).address
            await deployments.execute('DefaultProxyAdmin', { from: admin.address }, 'upgrade', proxy, implementation)

            const tx = await run('wXTMController', {})
            const [, target] = new ethers.utils.Interface([
                'function upgradeAndCall(address proxy, address implementation, bytes data)',
            ]).decodeFunctionData('upgradeAndCall', tx?.data ?? '0x')
            expect(target).to.equal(implementation)
            await send(tx)
            expect(await initializedVersion(proxy)).to.equal(SETUP_VERSION.wXTMController)
            await run('wXTMController', { check: true })
            expect((await deployments.get('wXTMController')).implementation).to.equal(implementation)
        })
    })
})
