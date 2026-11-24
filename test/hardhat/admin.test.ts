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
        const hreWith = (existing: boolean) =>
            ({ network: { name: 'mainnet' }, deployments: { getOrNull: async () => (existing ? {} : null) } }) as never

        it('fails before deploying when the proxy exists', async function () {
            let error: Error | undefined
            await assertDeployerCanUpgrade(hreWith(true), 'wXTM', DEPLOYER, ADMIN).catch((e: Error) => (error = e))
            expect(error?.message).to.match(/wXTM is already deployed on "mainnet" and its admin is 0xe178/)
        })

        it('allows a first deploy, or an upgrade run by the admin', async function () {
            await assertDeployerCanUpgrade(hreWith(false), 'wXTM', DEPLOYER, ADMIN)
            await assertDeployerCanUpgrade(hreWith(true), 'wXTM', ADMIN.toLowerCase(), ADMIN)
        })
    })
})
