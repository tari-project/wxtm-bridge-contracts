import { expect } from 'chai'
import { ethers } from 'ethers'
import { deployments } from 'hardhat'

import { getAdmin } from '../../utils/admin'

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
})
