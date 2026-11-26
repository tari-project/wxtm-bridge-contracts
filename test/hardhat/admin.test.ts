import { expect } from 'chai'
import { ethers } from 'ethers'
import { deployments } from 'hardhat'

import { assertNoUpgrade, assertUpgraded, chainDeployments, getAdmin, getGuardian } from '../../utils/admin'

const ADMIN = '0xe178b64Acf345A48a5a9FD34CA4F8d9cbA864fCB'

function hreWithAdmin(admin?: string) {
    return { network: { name: 'mainnet' }, getNamedAccounts: async () => (admin ? { admin } : {}) } as never
}

function hreWithGuardian(guardian?: string, code = '0x6080', deployer = '0x1111111111111111111111111111111111111111') {
    return {
        network: { name: 'mainnet' },
        getNamedAccounts: async () => ({ guardian, admin: ADMIN, deployer }),
        ethers: { provider: { getCode: async () => code } },
    } as never
}

describe('admin from named config', function () {
    // The hardhat network has no `admin` entry, so this is a dry-run deploy with the admin config unset.
    for (const tag of ['wXTM', 'wXTMController', 'wXTMBridge']) {
        it(`a ${tag} deploy fails when no admin is configured`, async function () {
            let error: Error | undefined
            await deployments.fixture([tag]).catch((e: Error) => (error = e))
            expect(error?.message).to.match(/No admin for network "hardhat"/)
        })
    }

    it('rejects an unset or zero admin', async function () {
        for (const admin of [undefined, ethers.constants.AddressZero]) {
            let error: Error | undefined
            await getAdmin(hreWithAdmin(admin)).catch((e: Error) => (error = e))
            expect(error?.message).to.match(/set namedAccounts\.admin\["mainnet"\]/)
        }
    })

    it('returns the configured admin', async function () {
        expect(await getAdmin(hreWithAdmin(ADMIN))).to.equal(ADMIN)
    })

    it('rejects an unset or zero guardian', async function () {
        for (const guardian of [undefined, ethers.constants.AddressZero]) {
            let error: Error | undefined
            await getGuardian(hreWithGuardian(guardian)).catch((e: Error) => (error = e))
            expect(error?.message).to.match(/set namedAccounts\.guardian\["mainnet"\]/)
        }
    })

    it('returns the configured guardian', async function () {
        const guardian = '0x3333333333333333333333333333333333333333'
        expect(await getGuardian(hreWithGuardian(guardian))).to.equal(guardian)
    })

    it('rejects a guardian that is not a contract (or is a delegated EOA), or is the admin or the deployer', async function () {
        const guardian = '0x3333333333333333333333333333333333333333'
        for (const hre of [
            hreWithGuardian(guardian, '0x'),
            hreWithGuardian(guardian, '0xef01007a664368c486cd924caf5ba9bd56b2e9f19dd72b'),
            hreWithGuardian(ADMIN.toLowerCase()),
            hreWithGuardian(guardian, '0x6080', guardian),
        ]) {
            let error: Error | undefined
            await getGuardian(hre).catch((e: Error) => (error = e))
            expect(error?.message).to.match(/must be a Safe, not the admin or the deployer/)
        }
    })

    describe('wXTM and package deployments for the chain', function () {
        const SEPOLIA_WXTM = '0xcBe79AB990E0Ab45Cb9148db7d434477E49b7374'
        const hreWith = (chainId: string, records: { [name: string]: string }) =>
            ({
                network: { name: 'some-network' },
                getChainId: async () => chainId,
                deployments: {
                    getOrNull: async (name: string) => (records[name] ? { address: records[name] } : null),
                },
            }) as never
        const failure = (hre: never, name: 'wXTMBridge' | 'wXTMController') =>
            chainDeployments(hre, name).then(
                () => undefined,
                (e: Error) => e
            )

        it('refuses a fresh deploy over a contract the package lists for the chain', async function () {
            const error = await failure(hreWith('84532', {}), 'wXTMBridge')
            expect(error?.message).to.match(/wXTMBridge for chain 84532 is listed at 0x5261.*Import that record/)
        })

        it("uses the chain's own wXTM when the contract has a local record", async function () {
            const { wXTM } = await chainDeployments(hreWith('11155111', { wXTMBridge: '0x01' }), 'wXTMBridge')
            expect(wXTM).to.equal(SEPOLIA_WXTM)
            const local = hreWith('11155111', { wXTMBridge: '0x01', wXTM: SEPOLIA_WXTM.toLowerCase() })
            expect((await chainDeployments(local, 'wXTMBridge')).wXTM).to.equal(SEPOLIA_WXTM.toLowerCase())
        })

        it('uses the local wXTM on a chain the package does not list (first deploy, or hardhat)', async function () {
            const local = '0x4444444444444444444444444444444444444444'
            expect((await chainDeployments(hreWith('31337', { wXTM: local }), 'wXTMController')).wXTM).to.equal(local)
        })

        it('refuses a local wXTM that differs from the package', async function () {
            const records = { wXTMBridge: '0x01', wXTM: '0x4444444444444444444444444444444444444444' }
            const error = await failure(hreWith('11155111', records), 'wXTMBridge')
            expect(error?.message).to.match(/is 0x4444.* in deployments\/some-network but 0xcBe7.*reconcile/)
        })

        it('refuses a chain without wXTM', async function () {
            const error = await failure(hreWith('8453', {}), 'wXTMController')
            expect(error?.message).to.match(/No wXTM for chain 8453/)
        })
    })

    describe('deploy scripts never upgrade', function () {
        const DEPLOYER = '0x1111111111111111111111111111111111111111'
        const IMPL = '0x2222222222222222222222222222222222222222'
        const OTHER = '0x5555555555555555555555555555555555555555'
        const options = { contract: 'wXTM', args: [], deterministicDeployment: '0x01' }
        const PROXY = '0x3333333333333333333333333333333333333333'
        const hreWith = (recorded: object | null, differences: boolean, address?: string, running = IMPL) =>
            ({
                network: { name: 'mainnet' },
                deployments: {
                    getOrNull: async () => recorded,
                    fetchIfDifferent: async () => ({ differences, address }),
                },
                ethers: { provider: { getStorageAt: async () => ethers.utils.hexZeroPad(running, 32) } },
            }) as never
        const failure = (hre: never) =>
            assertNoUpgrade(hre, 'wXTM', DEPLOYER, options).then(
                () => undefined,
                (e: Error) => e
            )
        const record = { address: PROXY, implementation: IMPL }

        it('fails before deploying when the implementation changed', async function () {
            const error = await failure(hreWith(record, true))
            expect(error?.message).to.match(/wXTM is already deployed on "mainnet".*upgrade-calldata:wxtm/)
        })

        it('fails when the new implementation already sits at its CREATE2 address (half-done upgrade)', async function () {
            expect((await failure(hreWith(record, false, OTHER)))?.message).to.match(/never upgrades/)
        })

        it('fails when the proxy does not run the recorded implementation', async function () {
            expect((await failure(hreWith(record, false, IMPL, OTHER)))?.message).to.match(/runs 0x5555/)
        })

        it('allows a first deploy and an unchanged rerun', async function () {
            expect(await failure(hreWith(null, true))).to.be.undefined
            expect(await failure(hreWith(record, false, IMPL.toUpperCase().replace('0X', '0x')))).to.be.undefined
        })
    })

    describe('upgrade and setup on-chain', function () {
        const IMPL = '0x2222222222222222222222222222222222222222'
        const GUARDIAN = '0x4444444444444444444444444444444444444444'
        const proxy = { address: '0x3333333333333333333333333333333333333333', implementation: IMPL }
        const PAUSER_ROLE = ethers.utils.id('PAUSER_ROLE').slice(2)
        const hreWith = (running: string, guardianCanPause: boolean, adminIsAdmin = true) =>
            ({
                network: { name: 'mainnet' },
                ethers: {
                    provider: {
                        getStorageAt: async () => ethers.utils.hexZeroPad(running, 32),
                        call: async ({ data }: { data: string }) =>
                            ethers.utils.defaultAbiCoder.encode(
                                ['bool'],
                                [data.includes(PAUSER_ROLE) ? guardianCanPause : adminIsAdmin]
                            ),
                    },
                },
            }) as never
        const failure = (hre: never) =>
            assertUpgraded(hre, 'wXTMBridge', proxy, ADMIN, GUARDIAN).then(
                () => undefined,
                (e: Error) => e
            )

        it('names each failed check', async function () {
            expect((await failure(hreWith(ADMIN, true)))?.message).to.match(/it runs 0xe178.*upgrade-calldata:wxtm/)
            expect((await failure(hreWith(IMPL, false)))?.message).to.match(/guardian 0x4444.* lacks PAUSER_ROLE/)
            expect((await failure(hreWith(IMPL, true, false)))?.message).to.match(
                /admin 0xe178.* lacks DEFAULT_ADMIN_ROLE/
            )
        })

        it('passes when the proxy runs the implementation and admin and guardian hold their roles', async function () {
            expect(await failure(hreWith(IMPL, true))).to.be.undefined
        })
    })
})
