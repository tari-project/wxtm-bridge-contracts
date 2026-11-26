import { expect } from 'chai'
import { ethers } from 'ethers'
import { artifacts } from 'hardhat'

import { upgradeCalldata } from '../../tasks/wxtm'

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
})
