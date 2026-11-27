import { expect } from 'chai'
import { ethers } from 'ethers'
import hre, { deployments } from 'hardhat'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

import { assertNotListedElsewhere, assertUpgraded, chainDeployments, getAdmin, getGuardian } from '../../utils/admin'

import { deploySafeMock, makeSafeProxy } from './safeMock'

const ADMIN = '0xe178b64Acf345A48a5a9FD34CA4F8d9cbA864fCB'

function hreWithAdmin(admin?: string) {
    return { network: { name: 'mainnet' }, getNamedAccounts: async () => (admin ? { admin } : {}) } as never
}

// Mainnet's minters.
const LOW_MINTER = '0x7cC835597EADFa3C5A5d9f0B90c0491C289B8Eee'
const HIGH_MINTER = '0xFa2459708A9549C371963a3fCd239dd614E8D52C'

function hreWithGuardian(
    guardian?: string,
    deployer = '0x1111111111111111111111111111111111111111',
    [lowMinter, highMinter]: (string | undefined)[] = [LOW_MINTER, HIGH_MINTER]
) {
    return Object.assign(Object.create(hre), {
        getNamedAccounts: async () => ({ guardian, admin: ADMIN, deployer, lowMinter, highMinter }),
    }) as HardhatRuntimeEnvironment
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

    const DEPLOYER = '0x1111111111111111111111111111111111111111'
    const guardianError = (hre: HardhatRuntimeEnvironment, deploying = true) =>
        getGuardian(hre, { deploying }).then(
            () => undefined,
            (e: Error) => e.message
        )

    it('rejects an unset or zero guardian', async function () {
        for (const guardian of [undefined, ethers.constants.AddressZero]) {
            expect(await guardianError(hreWithGuardian(guardian))).to.match(/set namedAccounts\.guardian\["hardhat"\]/)
        }
    })

    it('accepts an official Safe owned by plain keys, and refuses anything else', async function () {
        const [signer, owner] = await hre.ethers.getSigners()
        const safe = await makeSafeProxy([owner.address])
        expect(await getGuardian(hreWithGuardian(safe), { deploying: true })).to.deep.equal({
            guardian: safe,
            owners: [owner.address],
            threshold: 1,
        })

        const delegated = '0x5555555555555555555555555555555555555555'
        await hre.network.provider.send('hardhat_setCode', [delegated, `0xef0100${safe.slice(2)}`])
        const withModule = await makeSafeProxy([owner.address])
        await (
            await new ethers.Contract(withModule, ['function addModule(address)'], signer).addModule(owner.address)
        ).wait()
        const withGuard = await makeSafeProxy([owner.address])
        const guardSlot = ethers.utils.id('guard_manager.guard.address')
        await hre.network.provider.send('hardhat_setStorageAt', [
            withGuard,
            guardSlot,
            ethers.utils.hexZeroPad(safe, 32),
        ])
        const notASafe = (await (await hre.ethers.getContractFactory('wTARIBridge')).deploy()).address
        for (const [guardian, reason] of [
            [owner.address, /no code|not an official SafeProxy/], // a key
            [delegated, /not an official SafeProxy/], // an EIP-7702 delegated key
            [notASafe, /not an official SafeProxy/], // e.g. a ProxyAdmin or a token
            [await deploySafeMock(signer, [owner.address]), /not an official SafeProxy/], // Safe-shaped, not a Safe
            [withModule, /has modules enabled/],
            [withGuard, /has a transaction guard set/],
            [await makeSafeProxy([]), /threshold 1 of 0 owners/], // uninitialised
            [await makeSafeProxy([owner.address], 2), /threshold 2 of 1 owners/],
            [await makeSafeProxy([owner.address, ADMIN]), /neither it nor its owners may be the admin/],
            [await makeSafeProxy([DEPLOYER]), /neither it nor its owners may be the admin/],
            [await makeSafeProxy([HIGH_MINTER]), /neither it nor its owners may be the admin/],
            [await makeSafeProxy([safe]), /owned by plain keys only/], // a contract owner
            [await makeSafeProxy([delegated]), /owned by plain keys only/], // an EIP-7702 delegated owner
        ] as [string, RegExp][]) {
            expect(await guardianError(hreWithGuardian(guardian, DEPLOYER)), guardian).to.match(reason)
        }
    })

    it('refuses a deployer-owned guardian only when deploying', async function () {
        const ownedByDeployer = await makeSafeProxy([DEPLOYER])
        expect(await guardianError(hreWithGuardian(ownedByDeployer, DEPLOYER))).to.match(/or the deployer/)
        expect(await guardianError(hreWithGuardian(ownedByDeployer, DEPLOYER), false)).to.equal(undefined)
    })

    it("checks the guardian against the network's own minters, and fails without them", async function () {
        // As on sepolia-testnet: one address is both minters (and the admin there).
        const sepoliaMinter = '0x226F0e896a78A1848e4Fa25ce901108F0d61c7f3'
        const ownedBySepoliaMinter = await makeSafeProxy([sepoliaMinter])
        const errorOf = (minters?: (string | undefined)[]) =>
            guardianError(hreWithGuardian(ownedBySepoliaMinter, undefined, minters))
        expect(await errorOf([sepoliaMinter, sepoliaMinter])).to.match(/may be the admin, a minter/)
        expect(await errorOf()).to.equal(undefined) // with mainnet's minters it is accepted
        // The guardian itself configured as a minter.
        expect(await errorOf([ownedBySepoliaMinter, HIGH_MINTER])).to.match(/may be the admin, a minter/)
        expect(await errorOf([undefined, undefined])).to.match(
            /No minters for network "hardhat": set namedAccounts\.lowMinter/
        )
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
        const refusalOf = (promise: Promise<unknown>) =>
            promise.then(
                () => undefined,
                (e: Error) => e
            )
        const failure = (hre: never, name: 'wXTMBridge' | 'wXTMController') => refusalOf(chainDeployments(hre, name))

        it('refuses a fresh deploy over a contract the package lists for the chain', async function () {
            const error = await failure(hreWith('84532', {}), 'wXTMBridge')
            expect(error?.message).to.match(
                /wXTMBridge for chain 84532 is listed at 0x5261.*Import its records \(wXTMBridge.json, wXTMBridge_Implementation.json, wXTMBridge_Proxy.json\)/
            )
        })

        it('refuses a fresh wXTM deploy on a chain the package lists it for', async function () {
            const error = await refusalOf(assertNotListedElsewhere(hreWith('11155111', {}), 'wXTM'))
            expect(error?.message).to.match(/wXTM for chain 11155111 is listed at 0xcBe7.*Import its records/)
            expect(await refusalOf(assertNotListedElsewhere(hreWith('31337', {}), 'wXTM'))).to.be.undefined
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

        it('counts a reverting hasRole as no role, and rethrows any other error', async function () {
            const failing = (error: object) =>
                ({
                    network: { name: 'mainnet' },
                    ethers: {
                        provider: {
                            getStorageAt: async () => ethers.utils.hexZeroPad(IMPL, 32),
                            call: async () => Promise.reject(Object.assign(new Error('call failed'), error)),
                        },
                    },
                }) as never
            expect((await failure(failing({ code: 'CALL_EXCEPTION' })))?.message).to.match(/lacks PAUSER_ROLE/)
            expect((await failure(failing({ code: 'SERVER_ERROR' })))?.message).to.equal('call failed')
        })

        it('passes when the proxy runs the implementation and admin and guardian hold their roles', async function () {
            expect(await failure(hreWith(IMPL, true))).to.be.undefined
        })
    })
})
