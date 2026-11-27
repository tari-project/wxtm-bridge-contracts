import { expect } from 'chai'
import { ethers } from 'ethers'
import hre, { deployments } from 'hardhat'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

import deployWxtm from '../../deploy/wxtm/0_wXTM'
import deployController from '../../deploy/wxtm/1_wXTMController'
import deployBridge from '../../deploy/wxtm/2_wXTMBridge'

import { makeSafeProxy } from './safeMock'

describe('deploy/wxtm scripts', function () {
    this.timeout(120_000)

    it('deploy new proxies once; reruns send nothing and change no record, also after an admin rotation', async function () {
        await deployments.fixture(['none']) // empty in-memory deployments
        const [deployer, admin, newAdmin] = await hre.ethers.getSigners()
        const from = deployer.address
        const guardian = await makeSafeProxy(['0x7777777777777777777777777777777777777777'])
        // Any contract stands in for wXTM (recorded, so 0_wXTM leaves it alone).
        const wxtm = (await deployments.deploy('wXTMStandIn', { contract: 'wTARIBridge', from })).address
        await deployments.save('wXTM', { address: wxtm, abi: [] })

        const runAll = async (configuredAdmin: string) => {
            const scriptHre = Object.assign(Object.create(hre), {
                getNamedAccounts: async () => ({
                    // Mainnet's minters; any addresses other than the guardian's owners.
                    lowMinter: '0x7cC835597EADFa3C5A5d9f0B90c0491C289B8Eee',
                    highMinter: '0xFa2459708A9549C371963a3fCd239dd614E8D52C',
                    deployer: from,
                    admin: configuredAdmin,
                    guardian,
                }),
            }) as HardhatRuntimeEnvironment
            for (const script of [deployWxtm, deployController, deployBridge]) await script(scriptHre)
        }
        const records = async () =>
            Object.fromEntries(
                Object.entries(await deployments.all()).map(([name, d]) => [name, [d.address, d.implementation]])
            )
        const nonces = async () =>
            Promise.all([from, admin.address, newAdmin.address].map((a) => hre.ethers.provider.getTransactionCount(a)))

        // The scripts wait for 5 confirmations.
        await hre.network.provider.send('evm_setIntervalMining', [10])
        try {
            await runAll(admin.address)
            const bridge = await deployments.get('wXTMBridge')
            expect(bridge.implementation).to.not.equal(undefined)
            expect((await deployments.get('wXTM')).address).to.equal(wxtm)

            const [deployed, sent] = [await records(), await nonces()]
            await runAll(admin.address)
            expect(await nonces()).to.deep.equal(sent)
            expect(await records()).to.deep.equal(deployed)

            // Admin rotation: a rerun must not deploy a ProxyAdmin for the new admin.
            await deployments.execute(
                'DefaultProxyAdmin',
                { from: admin.address },
                'transferOwnership',
                newAdmin.address
            )
            for (const name of ['wXTMController', 'wXTMBridge']) {
                const adminRole = ethers.constants.HashZero
                await deployments.execute(name, { from: admin.address }, 'grantRole', adminRole, newAdmin.address)
            }
            const [rotated, sentRotated] = [await records(), await nonces()]
            await runAll(newAdmin.address)
            expect(await nonces()).to.deep.equal(sentRotated)
            expect(await records()).to.deep.equal(rotated)
        } finally {
            await hre.network.provider.send('evm_setIntervalMining', [0])
        }
    })
})
