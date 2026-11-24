import { expect } from 'chai'
import { ethers } from 'ethers'
import { deployments } from 'hardhat'

import { assertDeployerCanUpgrade, getAdmin } from '../../utils/admin'

const ADMIN = '0xe178b64Acf345A48a5a9FD34CA4F8d9cbA864fCB'

function hreWithAdmin(admin?: string) {
    return { network: { name: 'mainnet' }, getNamedAccounts: async () => (admin ? { admin } : {}) } as never
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

    describe('upgrade by a deployer that is not the admin', function () {
        const DEPLOYER = '0x1111111111111111111111111111111111111111'
        const IMPL = '0x2222222222222222222222222222222222222222'
        const options = { contract: 'wXTM', args: [], deterministicDeployment: '0x01' }
        const hreWith = (recorded: object | null, differences: boolean, address?: string) =>
            ({
                network: { name: 'mainnet' },
                deployments: {
                    getOrNull: async () => recorded,
                    fetchIfDifferent: async () => ({ differences, address }),
                },
            }) as never
        const failure = (hre: never, deployer = DEPLOYER) =>
            assertDeployerCanUpgrade(hre, 'wXTM', deployer, ADMIN, options).then(
                () => undefined,
                (e: Error) => e
            )

        it('fails before deploying when the implementation changed', async function () {
            const error = await failure(hreWith({ implementation: IMPL }, true))
            expect(error?.message).to.match(/wXTM is already deployed on "mainnet" and its admin is 0xe178/)
        })

        it('fails on a rerun after a half-done upgrade (implementation deployed, proxy not upgraded)', async function () {
            const error = await failure(hreWith({ implementation: IMPL }, false, ADMIN))
            expect(error?.message).to.match(/already deployed/)
        })

        it('allows an unchanged rerun by a deployer that is not the admin', async function () {
            expect(await failure(hreWith({ implementation: IMPL }, false, IMPL.toUpperCase().replace('0X', '0x')))).to
                .be.undefined
        })

        it('allows a first deploy, or an upgrade run by the admin', async function () {
            expect(await failure(hreWith(null, true))).to.be.undefined
            expect(await failure(hreWith({ implementation: IMPL }, true), ADMIN.toLowerCase())).to.be.undefined
        })
    })
})
