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
    REFERENCE_SAFES,
    WTARI_RECORD_NAMES,
    WtariChainConfig,
    checkWtariDeployment,
    deployWtari,
    etherscanVerify,
    expectedWtariCreations,
    exportedChainEntry,
    fetchLogs,
    officialLzEndpoint,
    readWtariConfig,
    safeSingletons,
    safeTxHash,
    uncheckedImmutables,
    verifyWtariContracts,
    withRedactedRpcUrls,
    wtariPackageProblems,
} from '../../tasks/wtari'
import { WagmiAddress, getDeployments, getWtariChains } from '../../wxtm-bridge-contracts-typechain/deployments'

const ROOT = path.join(__dirname, '..', '..')
const SAFE_SINGLETON = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762'
// Runtime code of an official v1.4.1 SafeProxy (from SafeProxyFactory 0x4e1DCf7A...proxyCreationCode on Ethereum).
const SAFE_PROXY_V141_RUNTIME =
    '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033'
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
            '    IwTARI private wtari;\n\n' +
                '    // Low-tier mints share one budget per fixed 24h window (block.timestamp / 1 days), not a rolling one:\n' +
                '    // up to 2x the limit can be minted across a window boundary.\n' +
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

    it('pin the LayerZero endpoint per eid and tie each eid to its chain', function () {
        expect(officialLzEndpoint(40245, 84532)).to.equal('0x6EDCE65403992e310A62460808c4b910D972f10f')
        expect(officialLzEndpoint(30184, 8453)).to.equal('0x1a44076050125825900e736c501f859c50fE728c')
        expect(() => officialLzEndpoint(40245, 8453)).to.throw(
            'LayerZero eid 40245 belongs to chain 84532, not chain 8453'
        )
        expect(() => officialLzEndpoint(40231, 421614)).to.throw('pin the endpoint for eid 40231 in tasks/wtari.ts')
    })

    it('flag immutables that check:wtari does not check through a getter', function () {
        expect(uncheckedImmutables('wTARI', ['endpoint', 'decimalConversionRate'])).to.deep.equal([])
        expect(uncheckedImmutables('wTARI', ['endpoint', 'rogue'])).to.deep.equal(['rogue'])
        expect(uncheckedImmutables('wTARIBridge', ['anything'])).to.deep.equal(['anything'])
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

    it('reject configs that could leak secrets or drop production protections', function () {
        // Scratch configs: 999999 is not a real chain; 42161 (Arbitrum) is on the built-in mainnet list.
        const testnet = { ...readWtariConfig(84532), explorer: undefined }
        const mainnet = { ...readWtariConfig(8453), explorer: undefined }
        const explorer = (apiURL: string) => ({ apiURL, browserURL: '' })
        const cases: [number, object, string][] = [
            [999999, { ...testnet, referenceRpcUrlEnv: 'PRIVATE_KEY' }, 'RPC env var PRIVATE_KEY must match'],
            [
                999999,
                { ...testnet, network: { ...testnet.network, rpcUrlEnv: 'KMS_KEY_ID' } },
                'RPC env var KMS_KEY_ID must match',
            ],
            [
                999999,
                { ...testnet, explorer: explorer('https://evil.example/v2/api?chainid=999999') },
                'explorer.apiURL must be https://api.etherscan.io',
            ],
            [
                999999,
                { ...testnet, explorer: explorer('http://api.etherscan.io/v2/api?chainid=999999') },
                'explorer.apiURL must be https://api.etherscan.io',
            ],
            [
                999999,
                { ...testnet, explorer: explorer('https://api.etherscan.io/v2/api?chainid=84532') },
                'explorer.apiURL must have chainid=999999',
            ],
            [999999, { ...testnet, production: undefined }, '"production" must be true or false'],
            [999999, { ...testnet, lowMintDailyLimit: 500000 }, '"lowMintDailyLimit" must be a string of whole tokens'],
            [999999, { ...testnet, lowMintDailyLimit: '1.5' }, '"lowMintDailyLimit" must be a string of whole tokens'],
            [999999, { ...testnet, production: true }, '"production" must be true exactly when referenceChainId is 1'],
            [999999, { ...mainnet, production: false }, '"production" must be true exactly when referenceChainId is 1'],
            [42161, { ...testnet, production: false }, 'chain 42161 is a mainnet, so "production" must be true'],
        ]
        for (const [chainId, bad, message] of cases) {
            const file = path.join(ROOT, 'deploy', 'wtari', `${chainId}.json`)
            fs.writeFileSync(file, JSON.stringify(bad))
            try {
                expect(() => readWtariConfig(chainId)).to.throw(message)
            } finally {
                fs.rmSync(file, { force: true })
            }
        }
    })

    it('redact RPC URLs from errors', async function () {
        const config = readWtariConfig(84532)
        process.env.SEPOLIA_RPC_URL = 'https://sepolia.example/v2/SECRET_KEY'
        try {
            await expectRejection(
                withRedactedRpcUrls(config, async () => {
                    throw new Error(`could not detect network (url="${process.env.SEPOLIA_RPC_URL}")`)
                }),
                'could not detect network (url="<SEPOLIA_RPC_URL>")'
            )
        } finally {
            delete process.env.SEPOLIA_RPC_URL
        }
    })
})

// Local stand-in for the Etherscan V2 API: answers by `action` and records request URLs.
async function startExplorerStub(replies: { [action: string]: object }) {
    const urls: string[] = []
    const server = http.createServer((req, res) => {
        urls.push(`${req.method} ${req.url}`)
        const action =
            req.method === 'POST'
                ? 'verifysourcecode'
                : (new URL(req.url ?? '', 'http://stub').searchParams.get('action') ?? '')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(replies[action] ?? {}))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const apiURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/api?chainid=84532`
    return { server, urls, apiURL }
}

describe('Etherscan V2 verification', function () {
    const form = { contractaddress: '0x01', contractname: 'contracts/wTARI.sol:wTARI', compilerversion: 'v0.8.22' }

    it('submits and polls with the chainid query kept', async function () {
        const stub = await startExplorerStub({
            verifysourcecode: { status: '1', result: 'guid-1' },
            checkverifystatus: { status: '1', result: 'Pass - Verified' },
        })
        await etherscanVerify(stub.apiURL, 'key', form)
        stub.server.close()

        expect(stub.urls[0]).to.equal('POST /v2/api?chainid=84532')
        expect(stub.urls[1]).to.match(/^GET \/v2\/api\?chainid=84532&.*action=checkverifystatus.*guid=guid-1/)
    })

    it('throws when the explorer rejects the submission', async function () {
        const stub = await startExplorerStub({
            verifysourcecode: { status: '0', message: 'NOTOK', result: 'Invalid API Key' },
        })
        await expectRejection(etherscanVerify(stub.apiURL, 'key', form), 'submit failed: NOTOK Invalid API Key')
        stub.server.close()
    })

    it('accepts "already verified" only when the published compiler and contract name match', async function () {
        const alreadyVerified = { status: '0', result: 'Contract source code already verified' }
        const matching = await startExplorerStub({
            verifysourcecode: alreadyVerified,
            getsourcecode: { status: '1', result: [{ ContractName: 'wTARI', CompilerVersion: 'v0.8.22' }] },
        })
        await etherscanVerify(matching.apiURL, 'key', form)
        matching.server.close()

        const different = await startExplorerStub({
            verifysourcecode: alreadyVerified,
            getsourcecode: { status: '1', result: [{ ContractName: 'Evil', CompilerVersion: 'v0.8.22' }] },
        })
        await expectRejection(etherscanVerify(different.apiURL, 'key', form), 'already verified with different source')
        different.server.close()
    })
})

describe('deploy:wtari dry run', function () {
    let deployer: SignerWithAddress
    let safeOwner: SignerWithAddress
    let user: SignerWithAddress
    let safeAbi: object[]
    let safeMockFactory: ContractFactory
    let endpoint: Contract
    let lowSafe: Contract
    let highSafe: Contract
    let adminSafe: Contract
    let config: WtariChainConfig

    const toQuantity = (value: string | number) => ethers.BigNumber.from(value).toHexString()
    const toWord = (value: string | number) => ethers.utils.hexZeroPad(ethers.BigNumber.from(value).toHexString(), 32)
    const setStorage = (address: string, slot: string | number, value: string | number) =>
        ethers.provider.send('hardhat_setStorageAt', [address, toQuantity(slot), toWord(value)])

    // A real v1.4.1 SafeProxy whose singleton (SafeMock code at the official singleton address) uses
    // SafeMock's storage layout: slot 0 singleton, 1 owners, 2 threshold, 3 modules.
    async function makeSafe(owners: string[], threshold: number, singleton = SAFE_SINGLETON) {
        const address = ethers.Wallet.createRandom().address
        await ethers.provider.send('hardhat_setCode', [address, SAFE_PROXY_V141_RUNTIME])
        await setStorage(address, 0, singleton)
        await setStorage(address, 1, owners.length)
        const ownersStart = ethers.BigNumber.from(ethers.utils.keccak256(toWord(1)))
        for (let i = 0; i < owners.length; i++) {
            await setStorage(address, ownersStart.add(i).toHexString(), owners[i])
        }
        await setStorage(address, 2, threshold)
        return new Contract(address, safeAbi, safeOwner)
    }

    async function contracts() {
        return {
            token: await ethers.getContractAt('wTARI', (await deployments.get('wTARI')).address),
            controller: await ethers.getContractAt(
                'wTARIController',
                (await deployments.get('wTARIController')).address
            ),
            bridge: await ethers.getContractAt('wTARIBridge', (await deployments.get('wTARIBridge')).address),
        }
    }

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
        safeAbi = safeArtifact.abi
        safeMockFactory = new ContractFactory(safeAbi, safeArtifact.bytecode.object, deployer)
        const template = await safeMockFactory.deploy(SAFE_SINGLETON, [], 0)
        await ethers.provider.send('hardhat_setCode', [SAFE_SINGLETON, await ethers.provider.getCode(template.address)])

        const owners = [safeOwner.address, user.address]
        REFERENCE_SAFES[31337] = {
            mintLowSafe: (await makeSafe(owners, 2)).address,
            mintHighSafe: (await makeSafe(owners, 2)).address,
        }
        lowSafe = await makeSafe([user.address, safeOwner.address], 2)
        highSafe = await makeSafe(owners, 2)
        adminSafe = await makeSafe(owners, 2)

        config = {
            network: { name: 'hardhat', rpcUrlEnv: 'UNUSED_RPC_URL', defaultRpcUrl: '', eid: 1 },
            production: false,
            lowMintDailyLimit: '500000',
            mintLowSafe: lowSafe.address,
            mintHighSafe: highSafe.address,
            proxyAdminOwner: adminSafe.address,
            confirmations: 1,
            referenceChainId: 31337,
            referenceRpcUrlEnv: 'UNUSED_RPC_URL',
        }
    })

    after(function () {
        delete REFERENCE_SAFES[31337]
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
        const otherSafe = await makeSafe([user.address], 1)
        await expectRejection(
            deployWtari(hre, { ...config, mintHighSafe: otherSafe.address }, endpoint.address, ethers.provider),
            'owners differ from reference Safe'
        )
    })

    it('rejects anything that is not a plain official Safe, and a weak or shared admin Safe', async function () {
        const owners = [safeOwner.address, user.address]
        const reject = (overrides: Partial<WtariChainConfig>, message: string) =>
            expectRejection(deployWtari(hre, { ...config, ...overrides }, endpoint.address, ethers.provider), message)

        const notAProxy = await safeMockFactory.deploy(SAFE_SINGLETON, owners, 2)
        await reject({ mintHighSafe: notAProxy.address }, 'is not an official SafeProxy (runtime code hash mismatch)')

        const withModule = await makeSafe(owners, 2)
        await withModule.addModule(user.address)
        await reject({ mintHighSafe: withModule.address }, 'has modules enabled')

        const withGuard = await makeSafe(owners, 2)
        await setStorage(withGuard.address, ethers.utils.id('guard_manager.guard.address'), user.address)
        await reject({ proxyAdminOwner: withGuard.address }, 'has a transaction guard set')

        const withModuleGuard = await makeSafe(owners, 2)
        await setStorage(withModuleGuard.address, ethers.utils.id('module_manager.module_guard.address'), user.address)
        await reject({ mintHighSafe: withModuleGuard.address }, 'has a module guard set')

        const fakeSingleton = await makeSafe(owners, 2, user.address)
        await reject({ mintHighSafe: fakeSingleton.address }, 'is not an official Safe singleton on chain 31337')

        await reject({ mintHighSafe: lowSafe.address }, 'mintLowSafe and mintHighSafe must be different Safes')
        await reject({ proxyAdminOwner: highSafe.address }, 'proxyAdminOwner must differ from both mint Safes')
        await reject(
            { proxyAdminOwner: (await makeSafe(owners, 1)).address },
            'proxyAdminOwner threshold 1 must be at least 2'
        )
    })

    it('rejects a reference provider on the wrong chain', async function () {
        await expectRejection(
            deployWtari(hre, { ...config, referenceChainId: 1 }, endpoint.address, ethers.provider),
            'Reference provider is not on chain 1'
        )
    })

    it('deploys with the Safe in control and leaves one pending Safe transaction', async function () {
        const pending = await deployWtari(hre, config, endpoint.address, ethers.provider)
        const { token, controller } = await contracts()
        expect(pending?.to).to.equal(token.address)
        expect(pending?.value).to.equal('0')
        expect(pending?.data).to.equal(
            token.interface.encodeFunctionData('grantRole', [ethers.utils.id('MINTER_ROLE'), controller.address])
        )
        expect(await token.owner()).to.equal(adminSafe.address)

        await expectRejection(
            checkWtariDeployment(hre, config, ethers.provider, { expectedLzEndpoint: endpoint.address }),
            `the controller does not have MINTER_ROLE yet; execute this Safe transaction from proxyAdminOwner: to ${pending?.to}, value 0, data ${pending?.data}`
        )

        // Nothing can have been minted before the grant (ERC20Upgradeable's namespaced _totalSupply slot).
        const totalSupplySlot = ethers.BigNumber.from(
            '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00'
        ).add(2)
        await setStorage(token.address, totalSupplySlot.toHexString(), 1)
        await expectRejection(
            checkWtariDeployment(hre, config, ethers.provider, {
                expectedLzEndpoint: endpoint.address,
                preGrant: true,
            }),
            'wTARI: totalSupply 1 is not 0 before the controller holds MINTER_ROLE'
        )
        await setStorage(token.address, totalSupplySlot.toHexString(), 0)
        // What a Safe signer runs before signing: everything else must already pass, and only then is the
        // pending transaction (computed from the proven addresses) returned for printing.
        const preGrant = await checkWtariDeployment(hre, config, ethers.provider, {
            expectedLzEndpoint: endpoint.address,
            preGrant: true,
        })
        expect(preGrant.pendingSafeTransaction).to.deep.equal(pending)

        // Every caller of the check gets the production RPC rule, not only the tasks.
        await expectRejection(
            checkWtariDeployment(hre, { ...config, production: true }, ethers.provider, {
                expectedLzEndpoint: endpoint.address,
            }),
            'UNUSED_RPC_URL must be set for a production chain'
        )

        await adminSafe.exec(pending?.to, pending?.data)
        await checkWtariDeployment(hre, config, ethers.provider, { expectedLzEndpoint: endpoint.address })

        // A second run is a no-op with nothing pending.
        expect(await deployWtari(hre, config, endpoint.address, ethers.provider)).to.equal(undefined)
        await checkWtariDeployment(hre, config, ethers.provider, { expectedLzEndpoint: endpoint.address })
    })

    it('requires every record at its recomputed CREATE2 address, created through the factory', async function () {
        const check = () => checkWtariDeployment(hre, config, ethers.provider, { expectedLzEndpoint: endpoint.address })
        const { token } = await contracts()

        // A bridge proxy with the real implementation and admin but different init args.
        const bridgeRecord = await deployments.get('wTARIBridge')
        const proxyArtifact = JSON.parse(
            fs.readFileSync(
                path.join(ROOT, 'node_modules/hardhat-deploy/extendedArtifacts/TransparentUpgradeableProxy.json'),
                'utf8'
            )
        )
        const bridgeInterface = new ethers.utils.Interface(bridgeRecord.abi)
        const impostor = await new ContractFactory(proxyArtifact.abi, proxyArtifact.bytecode, deployer).deploy(
            bridgeRecord.implementation,
            (await deployments.get('wTARIProxyAdmin')).address,
            bridgeInterface.encodeFunctionData('initialize', [user.address])
        )
        await deployments.save('wTARIBridge', { ...bridgeRecord, address: impostor.address })
        try {
            await expectRejection(
                check(),
                `wTARIBridge: record address ${impostor.address} is not the expected CREATE2 address ${bridgeRecord.address}`
            )
        } finally {
            await deployments.save('wTARIBridge', bridgeRecord)
        }

        // A forged creation transaction hash cannot move the deployer or the replay start block.
        const tokenProxyRecord = await deployments.get('wTARI_Proxy')
        const otherTx = (await deployments.get('wTARIController_Proxy')).transactionHash
        await deployments.save('wTARI_Proxy', { ...tokenProxyRecord, transactionHash: otherTx })
        try {
            await expectRejection(check(), `wTARI: transaction ${otherTx} did not create ${token.address}`)
        } finally {
            await deployments.save('wTARI_Proxy', tokenProxyRecord)
        }

        await check()
    })

    it('never gives the deployer any role or ownership', async function () {
        const { token, controller } = await contracts()
        for (const contract of [token, controller]) {
            expect(await contract.queryFilter(contract.filters.RoleGranted(null, deployer.address))).to.have.length(0)
        }
        expect(await token.queryFilter(token.filters.OwnershipTransferred(null, deployer.address))).to.have.length(0)
    })

    it('initializers cannot be re-run', async function () {
        const { token, controller, bridge } = await contracts()
        await expectRejection(token.initialize('x', 'x', '1', user.address), 'InvalidInitialization')
        await expectRejection(
            controller.initialize(user.address, user.address, user.address, user.address, 1),
            'InvalidInitialization'
        )
        await expectRejection(bridge.initialize(user.address), 'InvalidInitialization')
    })

    it('mints through the low Safe and burns via bridgeToTariWithAuthorization with nonce 0', async function () {
        const { token, controller, bridge } = await contracts()
        const amount = ethers.utils.parseEther('3000')

        await expectRejection(
            controller.connect(user).mintLowAmount(user.address, amount),
            'AccessControlUnauthorizedAccount'
        )
        const mintData = controller.interface.encodeFunctionData('mintLowAmount', [user.address, amount])
        await lowSafe.exec(controller.address, mintData)
        expect((await token.balanceOf(user.address)).toString()).to.equal(amount.toString())

        const validBefore = (await ethers.provider.getBlock('latest')).timestamp + 3600
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

    it('accepts a relayed mint Safe execution (transaction sent to a relayer, not the Safe)', async function () {
        const { controller } = await contracts()
        // A relayer contract (here a plain SafeMock) temporarily added as a third owner of the low Safe.
        const relayer = await safeMockFactory.connect(safeOwner).deploy(SAFE_SINGLETON, [safeOwner.address], 1)
        const ownersStart = ethers.BigNumber.from(ethers.utils.keccak256(toWord(1)))
        await setStorage(lowSafe.address, 1, 3)
        await setStorage(lowSafe.address, ownersStart.add(2).toHexString(), relayer.address)

        const mintData = controller.interface.encodeFunctionData('mintLowAmount', [user.address, 1])
        const relayed = await relayer.exec(
            lowSafe.address,
            lowSafe.interface.encodeFunctionData('exec', [controller.address, mintData])
        )
        expect((await relayed.wait()).to).to.equal(relayer.address)

        await setStorage(lowSafe.address, ownersStart.add(2).toHexString(), 0)
        await setStorage(lowSafe.address, 1, 2)
        await checkWtariDeployment(hre, config, ethers.provider, { expectedLzEndpoint: endpoint.address })
    })

    it('verifyWtariContracts fails loudly, listing every unverified contract', async function () {
        const stub = await startExplorerStub({
            verifysourcecode: { status: '0', message: 'NOTOK', result: 'Invalid API Key' },
        })
        const previousKey = process.env.ETHERSCAN_API_KEY
        process.env.ETHERSCAN_API_KEY = 'key'
        let message = ''
        try {
            await verifyWtariContracts(hre, { ...config, explorer: { apiURL: stub.apiURL, browserURL: '' } })
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

    it('check:wtari catches changes it can undo: LZ settings, budget, bytecode and slots', async function () {
        const { token, controller } = await contracts()
        const asSafe = (contract: Contract, fn: string, args: unknown[]) =>
            adminSafe.exec(contract.address, contract.interface.encodeFunctionData(fn, args))
        const check = () => checkWtariDeployment(hre, config, ethers.provider, { expectedLzEndpoint: endpoint.address })

        await asSafe(token, 'setDelegate', [user.address])
        await expectRejection(check(), `wTARI: LayerZero delegate ${user.address} is not proxyAdminOwner`)
        await asSafe(token, 'setDelegate', [adminSafe.address])

        await asSafe(token, 'setMsgInspector', [user.address])
        await expectRejection(check(), `wTARI: msgInspector is set to ${user.address}`)
        await asSafe(token, 'setMsgInspector', [ethers.constants.AddressZero])

        await asSafe(token, 'setPreCrime', [user.address])
        await expectRejection(check(), `wTARI: preCrime is set to ${user.address}`)
        await asSafe(token, 'setPreCrime', [ethers.constants.AddressZero])

        await asSafe(controller, 'setLowMintDailyLimit', [1])
        await expectRejection(check(), 'wTARIController: lowMintDailyLimit 0.000000000000000001 is not 500000')
        await asSafe(controller, 'setLowMintDailyLimit', [ethers.utils.parseEther('500000')])

        const bridgeImplementation = (await deployments.get('wTARIBridge_Implementation')).address
        const bridgeCode = await ethers.provider.getCode(bridgeImplementation)
        await ethers.provider.send('hardhat_setCode', [bridgeImplementation, bridgeCode.slice(0, -2) + '00'])
        await expectRejection(
            check(),
            `wTARIBridge implementation ${bridgeImplementation.toLowerCase()}: runtime bytecode differs`
        )
        await ethers.provider.send('hardhat_setCode', [bridgeImplementation, bridgeCode])

        // The implementation bytecode is checked at the proxy's slot address, not the record's.
        const bridgeProxy = (await deployments.get('wTARIBridge')).address
        const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
        const otherImplementation = (await deployments.get('wTARIController_Implementation')).address
        await setStorage(bridgeProxy, implementationSlot, otherImplementation)
        await expectRejection(
            check(),
            `wTARIBridge implementation ${otherImplementation.toLowerCase()}: runtime bytecode differs`
        )
        await setStorage(bridgeProxy, implementationSlot, bridgeImplementation)

        // Initializer state: the bridge and controller must point at this wTARI proxy.
        await setStorage(bridgeProxy, 1, user.address)
        await expectRejection(
            check(),
            `wTARIBridge: token pointer ${user.address.toLowerCase()} is not the wTARI proxy ${token.address}`
        )
        await setStorage(bridgeProxy, 1, token.address)
        await setStorage(controller.address, 0, user.address)
        await expectRejection(
            check(),
            `wTARIController: token pointer ${user.address.toLowerCase()} is not the wTARI proxy ${token.address}`
        )
        await setStorage(controller.address, 0, token.address)

        // An implementation built for another endpoint is not at the expected CREATE2 address.
        await expectRejection(
            checkWtariDeployment(hre, config, ethers.provider, { expectedLzEndpoint: user.address }),
            'is not the expected CREATE2 address'
        )

        await check()
    })

    it('rejects a creation record whose transaction reverted', async function () {
        const check = () => checkWtariDeployment(hre, config, ethers.provider, { expectedLzEndpoint: endpoint.address })
        const bridgeProxyRecord = await deployments.get('wTARIBridge_Proxy')
        const creation = await ethers.provider.getTransaction(bridgeProxyRecord.transactionHash as string)

        // Same factory call again: CREATE2 to an occupied address makes the factory revert.
        let revertedHash = ''
        try {
            await deployer.sendTransaction({ to: creation.to, data: creation.data, gasLimit: 3_000_000 })
        } catch {
            // hardhat mines the reverted transaction and then throws
        }
        revertedHash = (await ethers.provider.getBlock('latest')).transactions[0]
        expect((await ethers.provider.getTransactionReceipt(revertedHash)).status).to.equal(0)

        await deployments.save('wTARIBridge_Proxy', { ...bridgeProxyRecord, transactionHash: revertedHash })
        try {
            await expectRejection(check(), `wTARIBridge: creation transaction ${revertedHash} did not succeed`)
        } finally {
            await deployments.save('wTARIBridge_Proxy', bridgeProxyRecord)
        }
        await check()
    })

    it('check:wtari keeps failing after a peer, enforced option, extra grant or stray mint', async function () {
        const { token, controller } = await contracts()
        const asSafe = (fn: string, args: unknown[]) =>
            adminSafe.exec(token.address, token.interface.encodeFunctionData(fn, args))
        const check = () => checkWtariDeployment(hre, config, ethers.provider, { expectedLzEndpoint: endpoint.address })

        await asSafe('setPeer', [2, ethers.utils.hexZeroPad(user.address, 32)])
        await asSafe('setPeer', [2, ethers.constants.HashZero])
        await expectRejection(check(), 'wTARI: PeerSet emitted for eid 2')

        await asSafe('setEnforcedOptions', [[{ eid: 2, msgType: 1, options: '0x0003' }]])
        await expectRejection(check(), 'wTARI: EnforcedOptionSet emitted')

        // A grant that is later revoked still fails: grant, mint, revoke cannot leave a clean holder set.
        const minterRole = ethers.utils.id('MINTER_ROLE')
        await asSafe('grantRole', [minterRole, user.address])
        const strayMint = await token.connect(user).mint(user.address, 1)
        await asSafe('revokeRole', [minterRole, user.address])
        await expectRejection(
            check(),
            `wTARI: MINTER_ROLE was granted to ${user.address}, which is not an expected holder`
        )
        await expectRejection(
            check(),
            `wTARI: mint in transaction ${strayMint.hash} was not part of a mint Safe execution`
        )

        // A mint executed by a Safe that is not a mint Safe (here the admin Safe) is not a mint Safe execution.
        await asSafe('grantRole', [minterRole, adminSafe.address])
        const adminMint = await asSafe('mint', [user.address, 1])
        await asSafe('revokeRole', [minterRole, adminSafe.address])
        await expectRejection(
            check(),
            `wTARI: mint in transaction ${adminMint.hash} was not part of a mint Safe execution`
        )

        await asSafe('grantRole', [minterRole, deployer.address])
        await asSafe('revokeRole', [minterRole, deployer.address])
        await expectRejection(
            check(),
            `wTARI: MINTER_ROLE was granted to ${deployer.address}, which is not an expected holder`
        )

        // The controller's own grant must happen exactly once.
        await asSafe('revokeRole', [minterRole, controller.address])
        await asSafe('grantRole', [minterRole, controller.address])
        await expectRejection(
            check(),
            'wTARI: MINTER_ROLE was granted 5 times; expected exactly once, to the controller'
        )
    })
})

describe('log scan', function () {
    // An RPC that rejects ranges over 1000 blocks and returns one fake log per accepted chunk.
    const rangeLimitedRpc = (latest: number) => {
        const ranges: [number, number][] = []
        return {
            ranges,
            getBlockNumber: async () => latest,
            send: async (_method: string, [filter]: [{ fromBlock: string; toBlock: string }]) => {
                const from = Number(filter.fromBlock)
                const to = Number(filter.toBlock)
                if (to - from + 1 > 1000) throw new Error('query exceeds max block range 1000')
                ranges.push([from, to])
                return [{ blockNumber: to }]
            },
        }
    }

    it('halves the chunk on a range-limit error and covers every block exactly once', async function () {
        const rpc = rangeLimitedRpc(25_000)
        const logs = await fetchLogs(rpc, ['0x01'], 5, [])
        expect(rpc.ranges[0]).to.deep.equal([5, 629])
        expect(rpc.ranges[rpc.ranges.length - 1][1]).to.equal(25_000)
        for (let i = 1; i < rpc.ranges.length; i++) expect(rpc.ranges[i][0]).to.equal(rpc.ranges[i - 1][1] + 1)
        expect(logs).to.have.length(rpc.ranges.length)
    })

    it('rethrows other RPC errors', async function () {
        const rpc = {
            getBlockNumber: async () => 10,
            send: async () => {
                throw new Error('connection refused')
            },
        }
        await expectRejection(fetchLogs(rpc, ['0x01'], 0, []), 'connection refused')
    })
})

describe('verify:wtari-package (offline)', function () {
    let expected: { [name: string]: { address: string } }
    before(async function () {
        const config = readWtariConfig(84532)
        expected = await expectedWtariCreations(hre, config, officialLzEndpoint(config.network.eid, 84532))
    })
    const honest = () => {
        const entry: { [key: string]: string | number } = { wXTM: '0xcBe79AB990E0Ab45Cb9148db7d434477E49b7374' }
        for (const name of WTARI_RECORD_NAMES) entry[name] = expected[name].address
        entry.wTARIBridgeStartBlock = 1234
        return entry
    }

    it('passes an honest entry and leaves chains without wTARI alone', async function () {
        expect(await wtariPackageProblems(hre, { '1': { wXTM: '0x01' }, '84532': honest() })).to.deep.equal([])
    })

    it('fails a wrong address, a missing or extra wTARI key, a bad start block, or an unconfigured chain', async function () {
        const cases: [object, string][] = [
            [
                { ...honest(), wTARIBridge: '0x0000000000000000000000000000000000000001' },
                'wTARIBridge 0x0000000000000000000000000000000000000001 is not the expected CREATE2 address',
            ],
            [{ ...honest(), wTARIBridge_Proxy: undefined }, 'missing wTARIBridge_Proxy'],
            [{ ...honest(), wTARIRogue: '0x01' }, 'unexpected key wTARIRogue'],
            [{ ...honest(), wTARIBridgeStartBlock: 0 }, 'wTARIBridgeStartBlock 0 is not a positive integer'],
        ]
        for (const [entry, problem] of cases) {
            const json = JSON.parse(JSON.stringify(entry))
            const problems = await wtariPackageProblems(hre, { '84532': json })
            expect(problems.join('\n')).to.include(problem)
        }
        expect(await wtariPackageProblems(hre, { '421614': { wTARI: '0x01' } })).to.deep.equal([
            'chain 421614: has wTARI entries but no deploy/wtari/421614.json',
        ])
    })
})

describe('Safe transaction hash', function () {
    it('matches the Safe v1.3+ EIP-712 safeTxHash computed by hand', function () {
        const safe = '0x8aead919E7716a0840cB84495fA1AC76e04f7845'
        const tx = {
            to: '0x0000000000000000000000000000000000000abc',
            value: '0',
            operation: 0,
            data: '0x1234',
            description: '',
        }
        const coder = ethers.utils.defaultAbiCoder
        // DOMAIN_SEPARATOR_TYPEHASH and SAFE_TX_TYPEHASH as hard-coded in Safe.sol (v1.3.0 / v1.4.1).
        const domainSeparator = ethers.utils.keccak256(
            coder.encode(
                ['bytes32', 'uint256', 'address'],
                ['0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218', 84532, safe]
            )
        )
        const structHash = ethers.utils.keccak256(
            coder.encode(
                [
                    'bytes32',
                    'address',
                    'uint256',
                    'bytes32',
                    'uint8',
                    'uint256',
                    'uint256',
                    'uint256',
                    'address',
                    'address',
                    'uint256',
                ],
                [
                    '0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8',
                    tx.to,
                    0,
                    ethers.utils.keccak256(tx.data),
                    0,
                    0,
                    0,
                    0,
                    ethers.constants.AddressZero,
                    ethers.constants.AddressZero,
                    7,
                ]
            )
        )
        const byHand = ethers.utils.keccak256(ethers.utils.hexConcat(['0x1901', domainSeparator, structHash]))
        expect(safeTxHash(tx, safe, 84532, 7)).to.equal(byHand)
    })
})

describe('export-deployments wTARI gate', function () {
    const wxtm = { wXTM: '0x01', DefaultProxyAdmin: '0x02' }
    const wtari: { [name: string]: string } = {}
    WTARI_RECORD_NAMES.forEach((name, i) => (wtari[name] = `0x0${i}`))
    const passing = async () => 123
    const failing = async (): Promise<number> => {
        throw new Error('check failed')
    }

    it('exports wXTM-only networks unchanged and keeps earlier wTARI keys when there are no wTARI records', async function () {
        const previous = { wXTM: '0x01', wTARI: '0x0a', wTARIBridgeStartBlock: 7 }
        const { entry, wtariFailed } = await exportedChainEntry(previous, wxtm, failing)
        expect(entry).to.deep.equal({ ...previous, ...wxtm })
        expect(wtariFailed).to.equal(false)
    })

    it('exports a new wTARI set only after the check passes, with the proven start block', async function () {
        const { entry, wtariFailed } = await exportedChainEntry({}, { ...wxtm, ...wtari }, passing)
        expect(entry).to.deep.equal({ ...wxtm, ...wtari, wTARIBridgeStartBlock: 123 })
        expect(wtariFailed).to.equal(false)
    })

    it('keeps the last good wTARI set when a changed set fails the check, is partial, or has extra records', async function () {
        const previous = { wXTM: '0x01', wTARI: '0x99', wTARIBridgeStartBlock: 7 }
        const partial = { wTARI: '0x0a', wTARIController: '0x0b' }
        for (const records of [wtari, partial, { ...wtari, wTARIExtra: '0x0e' }]) {
            const { entry, wtariFailed } = await exportedChainEntry(previous, { ...wxtm, ...records }, failing)
            expect(entry).to.deep.equal({ ...wxtm, wTARI: '0x99', wTARIBridgeStartBlock: 7 })
            expect(wtariFailed).to.equal(true)
        }
    })

    it('omits every wTARI key when the check fails and nothing was exported before', async function () {
        const { entry, wtariFailed } = await exportedChainEntry({ wXTM: '0x01' }, { ...wxtm, ...wtari }, failing)
        expect(entry).to.deep.equal(wxtm)
        expect(wtariFailed).to.equal(true)
    })

    it('keeps an unchanged, already exported wTARI set without re-running the check', async function () {
        const previous = { ...wxtm, ...wtari, wTARIBridgeStartBlock: 7 }
        const { entry, wtariFailed } = await exportedChainEntry(previous, { ...wxtm, ...wtari }, failing)
        expect(entry).to.deep.equal(previous)
        expect(wtariFailed).to.equal(false)
    })
})

describe('typechain package deployments', function () {
    it('getDeployments accepts the chain ids returned by getWtariChains', function () {
        for (const chainId of getWtariChains()) {
            expect(getDeployments(chainId).wTARIBridge).to.match(/^0x/)
        }
        expect(getDeployments(1).wTARI).to.equal(undefined)
        expect(getDeployments(11155111).wTARI).to.equal(undefined)
        expect(getDeployments(1).wXTM).to.equal('0xfD36fA88bb3feA8D1264fc89d70723b6a2B56958')

        // Type-level: wXTM chains keep wXTM required; other chain ids get optional fields.
        const known: WagmiAddress = getDeployments(1).wXTM
        const anyChain: WagmiAddress | undefined = getDeployments(getWtariChains()[0] ?? 8453).wXTM
        expect(known).to.not.equal(anyChain)
        // @ts-expect-error Base has no wXTM, so getDeployments(8453).wXTM is WagmiAddress | undefined.
        const base: WagmiAddress = getDeployments(8453).wXTM
        expect(base).to.equal(undefined)
    })
})
