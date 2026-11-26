import { expect } from 'chai'
import { ethers } from 'ethers'
import { deployments } from 'hardhat'

import { assertDeployerCanUpgrade, assertUpgraded, getAdmin, getGuardian } from '../../utils/admin'

const ADMIN = '0xe178b64Acf345A48a5a9FD34CA4F8d9cbA864fCB'

function hreWithAdmin(admin?: string) {
    return { network: { name: 'mainnet' }, getNamedAccounts: async () => (admin ? { admin } : {}) } as never
}

function hreWithGuardian(guardian?: string) {
    return { network: { name: 'mainnet' }, getNamedAccounts: async () => (guardian ? { guardian } : {}) } as never
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

    describe('upgrade that hardhat-deploy cannot complete', function () {
        const DEPLOYER = '0x1111111111111111111111111111111111111111'
        const IMPL = '0x2222222222222222222222222222222222222222'
        const options = { contract: 'wXTM', args: [], deterministicDeployment: '0x01' }
        const PROXY = '0x3333333333333333333333333333333333333333'
        const DEFAULT_PROXY_ADMIN = '0x67d3d893ce36D9628B82Be2860Cd5c021227B3bE'
        const hreWith = (
            recorded: object | null,
            differences: boolean,
            address?: string,
            proxyAdmin = DEFAULT_PROXY_ADMIN
        ) =>
            ({
                network: { name: 'mainnet' },
                deployments: {
                    getOrNull: async (name: string) =>
                        name === 'DefaultProxyAdmin' ? { address: DEFAULT_PROXY_ADMIN } : recorded,
                    fetchIfDifferent: async () => ({ differences, address }),
                },
                ethers: { provider: { getStorageAt: async () => ethers.utils.hexZeroPad(proxyAdmin, 32) } },
            }) as never
        const failure = (hre: never, deployer = DEPLOYER) =>
            assertDeployerCanUpgrade(hre, 'wXTM', deployer, ADMIN, options).then(
                () => undefined,
                (e: Error) => e
            )

        it('fails before deploying when the implementation changed', async function () {
            const error = await failure(hreWith({ address: PROXY, implementation: IMPL }, true))
            expect(error?.message).to.match(/wXTM is already deployed on "mainnet" and its admin is 0xe178/)
        })

        it('fails on a rerun after a half-done upgrade (implementation deployed, proxy not upgraded)', async function () {
            const error = await failure(hreWith({ address: PROXY, implementation: IMPL }, false, ADMIN))
            expect(error?.message).to.match(/already deployed/)
        })

        it('allows an unchanged rerun by a deployer that is not the admin', async function () {
            expect(
                await failure(
                    hreWith({ address: PROXY, implementation: IMPL }, false, IMPL.toUpperCase().replace('0X', '0x'))
                )
            ).to.be.undefined
        })

        it('allows a first deploy, or an upgrade run by the admin', async function () {
            expect(await failure(hreWith(null, true))).to.be.undefined
            expect(await failure(hreWith({ address: PROXY, implementation: IMPL }, true), ADMIN.toLowerCase())).to.be
                .undefined
        })

        it('fails before deploying an upgrade of a proxy that DefaultProxyAdmin does not administer', async function () {
            const other = '0x99fe3Eb343098811BA05BBA802D9f66e6A3960D2'
            const error = await failure(
                hreWith({ address: PROXY, implementation: IMPL }, true, undefined, other),
                ADMIN
            )
            expect(error?.message).to.match(/administered by 0x99fe.*not DefaultProxyAdmin.*upgradeAndCall/)
        })
    })

    describe('upgrade recorded by hardhat-deploy', function () {
        const IMPL = '0x2222222222222222222222222222222222222222'
        const GUARDIAN = '0x4444444444444444444444444444444444444444'
        const proxy = { address: '0x3333333333333333333333333333333333333333', implementation: IMPL }
        const hreWith = (running: string, guardianCanPause: boolean) =>
            ({
                network: { name: 'mainnet' },
                deployments: { read: async () => guardianCanPause },
                ethers: { provider: { getStorageAt: async () => ethers.utils.hexZeroPad(running, 32) } },
            }) as never
        const failure = (hre: never) =>
            assertUpgraded(hre, 'wXTMBridge', proxy, GUARDIAN).then(
                () => undefined,
                (e: Error) => e
            )

        it('fails when the proxy does not run the recorded implementation', async function () {
            const error = await failure(hreWith(ADMIN, true))
            expect(error?.message).to.match(/records an upgrade that did not happen.*upgradeAndCall/)
        })

        it('fails when the guardian has no PAUSER_ROLE', async function () {
            expect((await failure(hreWith(IMPL, false)))?.message).to.match(/has PAUSER_ROLE: false/)
        })

        it('passes when the proxy runs the recorded implementation and the guardian can pause', async function () {
            expect(await failure(hreWith(IMPL, true))).to.be.undefined
        })
    })
})
