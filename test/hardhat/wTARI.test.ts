import fs from 'fs'
import http from 'http'
import { AddressInfo } from 'net'
import path from 'path'

import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { expect } from 'chai'
import { Contract, ContractFactory } from 'ethers'
import hre, { deployments, ethers } from 'hardhat'
import { traverseMultipleDirectory } from 'hardhat-deploy/dist/src/utils'

import { networkForChain } from '../../scripts/wtari'
import {
    WtariChainConfig,
    checkWtariDeployment,
    deployWtari,
    etherscanVerify,
    readWtariConfig,
    safeSingletons,
    verifyWtariContracts,
} from '../../tasks/wtari'
import { WagmiAddress, getDeployments, getWtariChains } from '../../wxtm-bridge-contracts-typechain/deployments'

const ROOT = path.join(__dirname, '..', '..')
const SAFE_SINGLETON = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762'
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

// The only intentional differences from the renamed wXTM sources: the controller's daily low-tier budget (D14)
// and the bridge's target address check (D17). Each [from, to] pair must match exactly once.
const INTENTIONAL_DIFFS: { [clone: string]: [string, string][] } = {
    'wTARIController.sol': [
        [
            '    error UnauthorizedToMintThisAmount();\n',
            '    error UnauthorizedToMintThisAmount();\n    error LowMintDailyLimitExceeded();\n\n    event LowMintDailyLimitSet(uint256 limit);\n',
        ],
        [
            '    IwTARI private wtari;\n',
            '    IwTARI private wtari;\n\n    // Low-tier mints share one budget per fixed 24h window (block.timestamp / 1 days).\n' +
                '    uint256 public lowMintDailyLimit;\n    uint256 public lowMintWindow;\n    uint256 public lowMintedInWindow;\n',
        ],
        [
            '    function initialize(address _wtari, address lowMinter, address highMinter, address admin) external initializer {\n',
            '    function initialize(\n        address _wtari,\n        address lowMinter,\n        address highMinter,\n' +
                '        address admin,\n        uint256 _lowMintDailyLimit\n    ) external initializer {\n',
        ],
        [
            '        wtari = IwTARI(_wtari);\n    }\n',
            '        wtari = IwTARI(_wtari);\n\n        lowMintDailyLimit = _lowMintDailyLimit;\n' +
                '        emit LowMintDailyLimitSet(_lowMintDailyLimit);\n    }\n\n' +
                '    function setLowMintDailyLimit(uint256 limit) external onlyRole(DEFAULT_ADMIN_ROLE) {\n' +
                '        lowMintDailyLimit = limit;\n        emit LowMintDailyLimitSet(limit);\n    }\n',
        ],
        [
            '        if (amount > HIGH_MINT_THRESHOLD) revert UnauthorizedToMintThisAmount();\n',
            '        if (amount > HIGH_MINT_THRESHOLD) revert UnauthorizedToMintThisAmount();\n\n' +
                '        uint256 window = block.timestamp / 1 days;\n        if (window != lowMintWindow) {\n' +
                '            lowMintWindow = window;\n            lowMintedInWindow = 0;\n        }\n' +
                '        if (lowMintedInWindow + amount > lowMintDailyLimit) revert LowMintDailyLimitExceeded();\n' +
                '        lowMintedInWindow += amount;\n',
        ],
    ],
    'wTARIBridge.sol': [
        [
            '    error InsufficientAmount();\n',
            '    error InsufficientAmount();\n    error InvalidTargetTariAddress();\n\n' +
                '    uint256 private constant MAX_TARGET_TARI_ADDRESS_LENGTH = 128;\n',
        ],
        [
            '    function bridgeToTari(string memory targetTariAddress, uint256 value) external {\n' +
                '        if (value < 1000 ether) revert InsufficientAmount();\n',
            '    function bridgeToTari(string memory targetTariAddress, uint256 value) external {\n' +
                '        if (value < 1000 ether) revert InsufficientAmount();\n        _checkTargetTariAddress(targetTariAddress);\n',
        ],
        [
            '        bytes32 s\n    ) external {\n        if (value < 1000 ether) revert InsufficientAmount();\n',
            '        bytes32 s\n    ) external {\n        if (value < 1000 ether) revert InsufficientAmount();\n' +
                '        _checkTargetTariAddress(targetTariAddress);\n',
        ],
        [
            '        nonce++;\n    }\n}\n',
            '        nonce++;\n    }\n\n' +
                '    function _checkTargetTariAddress(string memory targetTariAddress) private pure {\n' +
                '        uint256 length = bytes(targetTariAddress).length;\n' +
                '        if (length == 0 || length > MAX_TARGET_TARI_ADDRESS_LENGTH) revert InvalidTargetTariAddress();\n' +
                '    }\n}\n',
        ],
    ],
}

describe('wTARI clones', function () {
    const pairs = [
        ['wXTM.sol', 'wTARI.sol'],
        ['wXTMController.sol', 'wTARIController.sol'],
        ['wXTMBridge.sol', 'wTARIBridge.sol'],
        ['interfaces/IwXTM.sol', 'interfaces/IwTARI.sol'],
    ]

    for (const [source, clone] of pairs) {
        it(`${clone} differs from ${source} by names and the listed intentional changes only`, function () {
            let expected = fs
                .readFileSync(path.join(ROOT, 'contracts', source), 'utf8')
                .replace(/wXTM/g, 'wTARI')
                .replace(/wxtm/g, 'wtari')
            for (const [from, to] of INTENTIONAL_DIFFS[clone] ?? []) {
                expect(expected.split(from).length, `exactly one match for: ${from}`).to.equal(2)
                expected = expected.replace(from, to)
            }
            expect(fs.readFileSync(path.join(ROOT, 'contracts', clone), 'utf8')).to.equal(expected)
        })
    }
})

describe('wTARI config files', function () {
    it('are not picked up by the hardhat-deploy script loader', function () {
        const scripts = traverseMultipleDirectory(hre.config.paths.deploy)
        expect(scripts.length).to.be.greaterThan(0)
        for (const script of scripts) {
            expect(script).to.not.include(path.join('deploy', 'wtari'))
            expect(script.endsWith('.ts')).to.equal(true)
        }
    })

    it('resolve the hardhat network for the npm run <task>:wtari wrapper', function () {
        expect(networkForChain('84532')).to.equal('base-sepolia-testnet')
        expect(networkForChain('8453')).to.equal('base-mainnet')
        expect(() => networkForChain('1')).to.throw('No wTARI config for chain 1')
    })

    it('point the Base explorers at the Etherscan V2 API', function () {
        for (const chainId of [84532, 8453]) {
            const explorer = readWtariConfig(chainId).explorer
            expect(explorer?.apiURL).to.equal(`https://api.etherscan.io/v2/api?chainid=${chainId}`)
        }
        expect(readWtariConfig(8453).production).to.equal(true)
        expect(readWtariConfig(84532).production).to.equal(false)
    })

    it('take the allowed Safe singletons for each chain from @safe-global/safe-deployments', function () {
        for (const chainId of [8453, 84532]) {
            const singletons = safeSingletons(chainId)
            // v1.3.0 canonical + eip155, v1.4.1, and v1.5.0 where listed.
            expect(singletons).to.include('0x69f4d1788e39c87893c980c06edf4b7f686e2938')
            expect(singletons).to.include('0xfb1bffc9d739b8d520daf37df666da4c687191ea')
            expect(singletons).to.include('0x29fcb43b46531bca003ddc8fcb67ffe91900c762')
        }
        expect(safeSingletons(8453)).to.include('0xedd160febbd92e350d4d398fb636302fccd67c7e')
        expect(safeSingletons(999999)).to.deep.equal([])
    })

    it('reject env var names and explorer hosts that could leak secrets', function () {
        const file = path.join(ROOT, 'deploy', 'wtari', '999999.json')
        const base = readWtariConfig(84532)
        const cases: [object, string][] = [
            [{ ...base, referenceRpcUrlEnv: 'PRIVATE_KEY' }, 'RPC env var PRIVATE_KEY must match'],
            [{ ...base, network: { ...base.network, rpcUrlEnv: 'KMS_KEY_ID' } }, 'RPC env var KMS_KEY_ID must match'],
            [
                { ...base, explorer: { apiURL: 'https://evil.example/v2/api', browserURL: '' } },
                'explorer.apiURL must be on api.etherscan.io',
            ],
            [{ ...base, production: undefined }, '"production" must be true or false'],
            [{ ...base, production: true }, '"production" must be true exactly when referenceChainId is 1'],
            [
                { ...readWtariConfig(8453), production: false },
                '"production" must be true exactly when referenceChainId is 1',
            ],
        ]
        try {
            for (const [bad, message] of cases) {
                fs.writeFileSync(file, JSON.stringify(bad))
                expect(() => readWtariConfig(999999)).to.throw(message)
            }
        } finally {
            fs.rmSync(file, { force: true })
        }
    })
})

// Local stand-in for the Etherscan V2 API: records request URLs and answers with the given bodies.
async function startExplorerStub(submitReply: object, statusReply: object) {
    const urls: string[] = []
    const server = http.createServer((req, res) => {
        urls.push(`${req.method} ${req.url}`)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(req.method === 'POST' ? submitReply : statusReply))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const apiURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/api?chainid=84532`
    return { server, urls, apiURL }
}

describe('Etherscan V2 verification', function () {
    it('submits and polls with the chainid query kept', async function () {
        const stub = await startExplorerStub(
            { status: '1', result: 'guid-1' },
            { status: '1', result: 'Pass - Verified' }
        )
        await etherscanVerify(stub.apiURL, 'key', { contractaddress: '0x01' })
        stub.server.close()

        expect(stub.urls[0]).to.equal('POST /v2/api?chainid=84532')
        expect(stub.urls[1]).to.match(/^GET \/v2\/api\?chainid=84532&.*action=checkverifystatus.*guid=guid-1/)
    })

    it('throws when the explorer rejects the submission', async function () {
        const stub = await startExplorerStub({ status: '0', message: 'NOTOK', result: 'Invalid API Key' }, {})
        await expectRejection(etherscanVerify(stub.apiURL, 'key', {}), 'submit failed: NOTOK Invalid API Key')
        stub.server.close()
    })
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

        // This EndpointV2Mock keeps a public `delegates` mapping like the real EndpointV2.
        const endpointArtifact = JSON.parse(
            fs.readFileSync(
                path.join(
                    ROOT,
                    'node_modules/@layerzerolabs/oapp-evm/artifacts/EndpointV2Mock.sol/EndpointV2Mock.json'
                ),
                'utf8'
            )
        )
        endpoint = await new ContractFactory(endpointArtifact.abi, endpointArtifact.bytecode.object, deployer).deploy(
            1,
            deployer.address
        )

        // SafeMock is a test-only contract, so it is compiled by forge rather than hardhat.
        const safeArtifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/SafeMock.sol/SafeMock.json'), 'utf8'))
        safeFactory = new ContractFactory(safeArtifact.abi, safeArtifact.bytecode.object, deployer)

        const owners = [safeOwner.address, user.address]
        const referenceLowSafe = await safeFactory.deploy(SAFE_SINGLETON, owners, 2)
        const referenceHighSafe = await safeFactory.deploy(SAFE_SINGLETON, owners, 2)
        lowSafe = await safeFactory.deploy(SAFE_SINGLETON, [user.address, safeOwner.address], 2)
        highSafe = await safeFactory.deploy(SAFE_SINGLETON, owners, 2)
        adminSafe = await safeFactory.deploy(SAFE_SINGLETON, owners, 2)

        config = {
            network: { name: 'hardhat', rpcUrlEnv: 'UNUSED_RPC_URL', defaultRpcUrl: '', eid: 1 },
            production: false,
            lowMintDailyLimit: 500000,
            mintLowSafe: lowSafe.address,
            mintHighSafe: highSafe.address,
            proxyAdminOwner: adminSafe.address,
            confirmations: 1,
            referenceChainId: 31337,
            referenceRpcUrlEnv: 'UNUSED_RPC_URL',
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
        const otherSafe = await safeFactory.deploy(SAFE_SINGLETON, [user.address], 1)
        const badConfig = { ...config, mintHighSafe: otherSafe.address }
        await expectRejection(
            deployWtari(hre, badConfig, endpoint.address, ethers.provider),
            'owners differ from reference Safe'
        )
    })

    it('rejects Safes with modules, a guard, a non-canonical singleton, or one Safe for both tiers', async function () {
        const owners = [safeOwner.address, user.address]
        const withModule = await safeFactory.deploy(SAFE_SINGLETON, owners, 2)
        await withModule.addModule(user.address)
        await expectRejection(
            deployWtari(hre, { ...config, mintHighSafe: withModule.address }, endpoint.address, ethers.provider),
            'has modules enabled'
        )

        const withGuard = await safeFactory.deploy(SAFE_SINGLETON, owners, 2)
        const guardSlot = ethers.utils.id('guard_manager.guard.address')
        await ethers.provider.send('hardhat_setStorageAt', [
            withGuard.address,
            guardSlot,
            ethers.utils.hexZeroPad(user.address, 32),
        ])
        await expectRejection(
            deployWtari(hre, { ...config, proxyAdminOwner: withGuard.address }, endpoint.address, ethers.provider),
            'has a transaction guard set'
        )

        const fakeSingleton = await safeFactory.deploy(user.address, owners, 2)
        await expectRejection(
            deployWtari(hre, { ...config, mintHighSafe: fakeSingleton.address }, endpoint.address, ethers.provider),
            'is not an official Safe singleton on chain 31337'
        )

        const withModuleGuard = await safeFactory.deploy(SAFE_SINGLETON, owners, 2)
        await ethers.provider.send('hardhat_setStorageAt', [
            withModuleGuard.address,
            ethers.utils.id('module_manager.module_guard.address'),
            ethers.utils.hexZeroPad(user.address, 32),
        ])
        await expectRejection(
            deployWtari(hre, { ...config, mintHighSafe: withModuleGuard.address }, endpoint.address, ethers.provider),
            'has a module guard set'
        )

        await expectRejection(
            deployWtari(hre, { ...config, mintHighSafe: lowSafe.address }, endpoint.address, ethers.provider),
            'mintLowSafe and mintHighSafe must be different Safes'
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
        await checkWtariDeployment(hre, config, ethers.provider)

        const token = await ethers.getContractAt('wTARI', (await deployments.get('wTARI')).address)
        expect(await token.symbol()).to.equal('wTARI')
        expect(await token.decimals()).to.equal(18)
        expect(await token.owner()).to.equal(adminSafe.address)
        expect(await token.hasRole(ethers.constants.HashZero, deployer.address)).to.equal(false)

        // A second run is a no-op rather than a failure.
        await deployWtari(hre, config, endpoint.address, ethers.provider)
        await checkWtariDeployment(hre, config, ethers.provider)
    })

    it('a re-run finishes an interrupted handover', async function () {
        const token = await ethers.getContractAt('wTARI', (await deployments.get('wTARI')).address)
        const adminRole = ethers.constants.HashZero

        // Died after transferOwnership, before renounceRole: the deployer still holds admin.
        await adminSafe
            .connect(safeOwner)
            .exec(token.address, token.interface.encodeFunctionData('grantRole', [adminRole, deployer.address]))
        await deployWtari(hre, config, endpoint.address, ethers.provider)
        await checkWtariDeployment(hre, config, ethers.provider)

        // Died after setDelegate, before transferOwnership: the deployer is still owner and admin.
        await adminSafe
            .connect(safeOwner)
            .exec(token.address, token.interface.encodeFunctionData('grantRole', [adminRole, deployer.address]))
        await adminSafe
            .connect(safeOwner)
            .exec(token.address, token.interface.encodeFunctionData('transferOwnership', [deployer.address]))
        expect(await token.owner()).to.equal(deployer.address)
        await deployWtari(hre, config, endpoint.address, ethers.provider)
        await checkWtariDeployment(hre, config, ethers.provider)
        expect(await token.owner()).to.equal(adminSafe.address)
        expect(await token.hasRole(adminRole, deployer.address)).to.equal(false)
    })

    it('uses the recorded deployer, not the current signer, for the handover and the check', async function () {
        const token = await ethers.getContractAt('wTARI', (await deployments.get('wTARI')).address)
        const adminRole = ethers.constants.HashZero
        const getNamedAccounts = hre.getNamedAccounts
        await adminSafe
            .connect(safeOwner)
            .exec(token.address, token.interface.encodeFunctionData('grantRole', [adminRole, deployer.address]))

        // Another key runs the tasks while the original deployer still holds admin.
        hre.getNamedAccounts = async () => ({ deployer: user.address })
        try {
            await expectRejection(
                deployWtari(hre, config, endpoint.address, ethers.provider),
                `wTARI was deployed by ${deployer.address}, which still holds wTARI DEFAULT_ADMIN_ROLE`
            )
            await expectRejection(
                checkWtariDeployment(hre, config, ethers.provider),
                `deployer ${deployer.address} still holds wTARI DEFAULT_ADMIN_ROLE`
            )
        } finally {
            hre.getNamedAccounts = getNamedAccounts
        }

        await deployWtari(hre, config, endpoint.address, ethers.provider)
        await checkWtariDeployment(hre, config, ethers.provider)
    })

    it('check:wtari catches extra role holders, OFT peers and a moved LZ delegate', async function () {
        const token = await ethers.getContractAt('wTARI', (await deployments.get('wTARI')).address)
        const asSafe = (fn: string, args: unknown[]) =>
            adminSafe.connect(safeOwner).exec(token.address, token.interface.encodeFunctionData(fn, args))
        const minterRole = ethers.utils.id('MINTER_ROLE')

        await asSafe('grantRole', [minterRole, user.address])
        await expectRejection(
            checkWtariDeployment(hre, config, ethers.provider),
            `wTARI: unexpected MINTER_ROLE holder ${user.address.toLowerCase()}`
        )
        await asSafe('revokeRole', [minterRole, user.address])

        await asSafe('setPeer', [2, ethers.utils.hexZeroPad(user.address, 32)])
        await expectRejection(checkWtariDeployment(hre, config, ethers.provider), 'wTARI: OFT peer set for eid 2')
        await asSafe('setPeer', [2, ethers.constants.HashZero])

        await asSafe('setDelegate', [user.address])
        await expectRejection(
            checkWtariDeployment(hre, config, ethers.provider),
            `wTARI: LayerZero delegate ${user.address} is not proxyAdminOwner`
        )
        await asSafe('setDelegate', [adminSafe.address])

        await checkWtariDeployment(hre, config, ethers.provider)
    })

    it('verifyWtariContracts fails loudly, listing every unverified contract', async function () {
        const stub = await startExplorerStub({ status: '0', message: 'NOTOK', result: 'Invalid API Key' }, {})
        const previousKey = process.env.ETHERSCAN_API_KEY
        process.env.ETHERSCAN_API_KEY = 'key'
        const explorer = { apiURL: stub.apiURL, browserURL: 'http://explorer' }
        let message = ''
        try {
            await verifyWtariContracts(hre, { ...config, explorer })
        } catch (e) {
            message = (e as Error).message
        }
        stub.server.close()
        process.env.ETHERSCAN_API_KEY = previousKey

        expect(message).to.include('Deployment is complete but these contracts are not verified')
        for (const name of [
            'wTARI_Implementation',
            'wTARIController_Implementation',
            'wTARIBridge_Implementation',
            'wTARI_Proxy',
            'wTARIController_Proxy',
            'wTARIBridge_Proxy',
            'wTARIProxyAdmin',
        ]) {
            expect(message).to.include(name)
        }
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
            controller.initialize(user.address, user.address, user.address, user.address, 1),
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

describe('typechain package deployments', function () {
    it('getDeployments accepts the chain ids returned by getWtariChains', function () {
        // Type-level check too: getWtariChains() returns number[], which getDeployments must accept.
        for (const chainId of getWtariChains()) {
            expect(getDeployments(chainId).wTARIBridge).to.match(/^0x/)
        }
        expect(getDeployments(1).wTARI).to.equal(undefined)
        expect(getDeployments(11155111).wTARI).to.equal(undefined)
        expect(getDeployments(1).wXTM).to.equal('0xfD36fA88bb3feA8D1264fc89d70723b6a2B56958')

        // Type-level: known chains keep wXTM required; other chain ids get optional fields.
        const known: WagmiAddress = getDeployments(1).wXTM
        const anyChain: WagmiAddress | undefined = getDeployments(getWtariChains()[0] ?? 8453).wXTM
        expect(known).to.not.equal(anyChain)
        // @ts-expect-error Base has no wXTM, so getDeployments(8453).wXTM is WagmiAddress | undefined.
        const base: WagmiAddress = getDeployments(8453).wXTM
        expect(base).to.equal(undefined)
    })
})
