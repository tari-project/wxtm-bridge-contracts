import fs from 'fs'
import path from 'path'

import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { expect } from 'chai'
import { Contract, ContractFactory } from 'ethers'
import hre, { deployments, ethers } from 'hardhat'

import { WtariChainConfig, checkWtariDeployment, deployWtari, readWtariConfig } from '../../tasks/wtari'

const ROOT = path.join(__dirname, '..', '..')
const OOTLE_ADDRESS =
    'otl_esm_1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7v9kn6'

async function expectRejection(promise: Promise<unknown>, message: string) {
    let error: Error | undefined
    try {
        await promise
    } catch (e) {
        error = e as Error
    }
    expect(error?.message).to.include(message)
}

describe('wTARI clones', function () {
    const pairs = [
        ['wXTM.sol', 'wTARI.sol'],
        ['wXTMController.sol', 'wTARIController.sol'],
        ['wXTMBridge.sol', 'wTARIBridge.sol'],
        ['interfaces/IwXTM.sol', 'interfaces/IwTARI.sol'],
    ]

    for (const [source, clone] of pairs) {
        it(`${clone} differs from ${source} by names only`, function () {
            const sourceText = fs.readFileSync(path.join(ROOT, 'contracts', source), 'utf8')
            const cloneText = fs.readFileSync(path.join(ROOT, 'contracts', clone), 'utf8')
            expect(cloneText).to.equal(sourceText.replace(/wXTM/g, 'wTARI').replace(/wxtm/g, 'wtari'))
        })
    }
})

describe('deploy:wtari dry run', function () {
    let deployer: SignerWithAddress
    let safeOwner: SignerWithAddress
    let user: SignerWithAddress
    let safeFactory: ContractFactory
    let endpoint: Contract
    let lowSafe: Contract
    let highSafe: Contract
    let adminSafe: Contract
    let config: WtariChainConfig

    before(async function () {
        ;[deployer, safeOwner, user] = await ethers.getSigners()

        const endpointArtifact = await deployments.getArtifact('EndpointV2Mock')
        endpoint = await new ContractFactory(endpointArtifact.abi, endpointArtifact.bytecode, deployer).deploy(1)

        // SafeMock is a test-only contract, so it is compiled by forge rather than hardhat.
        const safeArtifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/SafeMock.sol/SafeMock.json'), 'utf8'))
        safeFactory = new ContractFactory(safeArtifact.abi, safeArtifact.bytecode.object, deployer)

        const owners = [safeOwner.address, user.address]
        const referenceLowSafe = await safeFactory.deploy(owners, 2)
        const referenceHighSafe = await safeFactory.deploy(owners, 2)
        lowSafe = await safeFactory.deploy([user.address, safeOwner.address], 2)
        highSafe = await safeFactory.deploy(owners, 2)
        adminSafe = await safeFactory.deploy(owners, 2)

        config = {
            mintLowSafe: lowSafe.address,
            mintHighSafe: highSafe.address,
            proxyAdminOwner: adminSafe.address,
            confirmations: 1,
            referenceChainId: 31337,
            referenceRpcUrlEnv: 'UNUSED',
            referenceMintLowSafe: referenceLowSafe.address,
            referenceMintHighSafe: referenceHighSafe.address,
        }
    })

    it('rejects the placeholder Base configs', async function () {
        for (const chainId of [84532, 8453]) {
            const placeholder = { ...readWtariConfig(chainId), referenceChainId: 31337 }
            await expectRejection(
                deployWtari(hre, placeholder, endpoint.address, ethers.provider),
                'has no code on the target chain'
            )
        }
    })

    it('rejects a Safe whose owners differ from the reference Safe', async function () {
        const otherSafe = await safeFactory.deploy([user.address], 1)
        const badConfig = { ...config, mintHighSafe: otherSafe.address }
        await expectRejection(
            deployWtari(hre, badConfig, endpoint.address, ethers.provider),
            'owners differ from reference Safe'
        )
    })

    it('rejects a reference provider on the wrong chain', async function () {
        const badConfig = { ...config, referenceChainId: 1 }
        await expectRejection(
            deployWtari(hre, badConfig, endpoint.address, ethers.provider),
            'Reference provider is not on chain 1'
        )
    })

    it('deploys, hands over admin, and passes the post-deploy check', async function () {
        await deployWtari(hre, config, endpoint.address, ethers.provider)
        await checkWtariDeployment(hre, config)

        const token = await ethers.getContractAt('wTARI', (await deployments.get('wTARI')).address)
        expect(await token.symbol()).to.equal('wTARI')
        expect(await token.decimals()).to.equal(18)
        expect(await token.owner()).to.equal(adminSafe.address)
        expect(await token.hasRole(ethers.constants.HashZero, deployer.address)).to.equal(false)

        // A second run is a no-op rather than a failure.
        await deployWtari(hre, config, endpoint.address, ethers.provider)
        await checkWtariDeployment(hre, config)
    })

    it('initializers cannot be re-run', async function () {
        const token = await ethers.getContractAt('wTARI', (await deployments.get('wTARI')).address)
        const controller = await ethers.getContractAt(
            'wTARIController',
            (await deployments.get('wTARIController')).address
        )
        const bridge = await ethers.getContractAt('wTARIBridge', (await deployments.get('wTARIBridge')).address)

        await expectRejection(token.initialize('x', 'x', '1', user.address), 'InvalidInitialization')
        await expectRejection(
            controller.initialize(user.address, user.address, user.address, user.address),
            'InvalidInitialization'
        )
        await expectRejection(bridge.initialize(user.address), 'InvalidInitialization')
    })

    it('mints through the low Safe and burns via bridgeToTariWithAuthorization with nonce 0', async function () {
        const token = await ethers.getContractAt('wTARI', (await deployments.get('wTARI')).address)
        const controller = await ethers.getContractAt(
            'wTARIController',
            (await deployments.get('wTARIController')).address
        )
        const bridge = await ethers.getContractAt('wTARIBridge', (await deployments.get('wTARIBridge')).address)
        const amount = ethers.utils.parseEther('3000')

        await expectRejection(
            controller.connect(user).mintLowAmount(user.address, amount),
            'AccessControlUnauthorizedAccount'
        )
        const mintData = controller.interface.encodeFunctionData('mintLowAmount', [user.address, amount])
        await lowSafe.connect(safeOwner).exec(controller.address, mintData)
        expect((await token.balanceOf(user.address)).toString()).to.equal(amount.toString())

        const validBefore = Math.floor(Date.now() / 1000) + 3600
        const authNonce = ethers.utils.id('auth-nonce')
        const signature = await user._signTypedData(
            { name: 'wTARI', version: '1', chainId: 31337, verifyingContract: token.address },
            {
                ReceiveWithAuthorization: [
                    { name: 'from', type: 'address' },
                    { name: 'to', type: 'address' },
                    { name: 'value', type: 'uint256' },
                    { name: 'validAfter', type: 'uint256' },
                    { name: 'validBefore', type: 'uint256' },
                    { name: 'nonce', type: 'bytes32' },
                ],
            },
            { from: user.address, to: bridge.address, value: amount, validAfter: 0, validBefore, nonce: authNonce }
        )
        const { v, r, s } = ethers.utils.splitSignature(signature)

        const tx = await bridge
            .connect(user)
            .bridgeToTariWithAuthorization(OOTLE_ADDRESS, amount, 0, validBefore, authNonce, v, r, s)
        const receipt = await tx.wait()
        const event = receipt.events.find((e: { event?: string }) => e.event === 'TokensUnwrapped')
        expect(event.args.from).to.equal(user.address)
        expect(event.args.targetTariAddress).to.equal(OOTLE_ADDRESS)
        expect(event.args.amount.toString()).to.equal(amount.toString())
        expect(event.args.nonce.toNumber()).to.equal(0)
        expect((await token.balanceOf(user.address)).toNumber()).to.equal(0)
    })
})
