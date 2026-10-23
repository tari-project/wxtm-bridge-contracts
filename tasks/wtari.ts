import fs from 'fs'
import path from 'path'

import { getSafeL2SingletonDeployments, getSafeSingletonDeployments } from '@safe-global/safe-deployments'
import { Contract, ethers, providers } from 'ethers'
import { task, types } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import ProxyAdmin from 'hardhat-deploy/extendedArtifacts/ProxyAdmin.json'
import TransparentUpgradeableProxy from 'hardhat-deploy/extendedArtifacts/TransparentUpgradeableProxy.json'

import { EndpointId, endpointIdToNetwork } from '@layerzerolabs/lz-definitions'
import { getDeploymentAddressAndAbi } from '@layerzerolabs/lz-evm-sdk-v2'

export interface WtariChainConfig {
    // Hardhat network for this chain; hardhat.config.ts adds it unless defined there by hand.
    network: { name: string; rpcUrlEnv: string; defaultRpcUrl: string; eid: number }
    // Etherscan V2 explorer used by verify:wtari (apiURL includes ?chainid=<id>); key is ETHERSCAN_API_KEY.
    explorer?: { apiURL: string; browserURL: string }
    // Production chains must deploy with the KMS signer and an explicit RPC env var.
    production: boolean
    // Initial wTARIController low-tier budget per fixed 24h window: whole tokens as a decimal string.
    lowMintDailyLimit: string
    mintLowSafe: string
    mintHighSafe: string
    proxyAdminOwner: string
    confirmations: number
    // Ethereum chain whose mint Safes (REFERENCE_SAFES) the mint Safes must match.
    referenceChainId: number
    referenceRpcUrlEnv: string
}

export interface SafeTransaction {
    to: string
    value: string
    // Safe operation: 0 = CALL
    operation: number
    data: string
    description: string
}

// The wXTM mint Safes each chain's mint Safes must mirror (owners and threshold), by reference chain id.
export const REFERENCE_SAFES: { [chainId: number]: { mintLowSafe: string; mintHighSafe: string } } = {
    1: {
        mintLowSafe: '0x7cC835597EADFa3C5A5d9f0B90c0491C289B8Eee',
        mintHighSafe: '0xFa2459708A9549C371963a3fCd239dd614E8D52C',
    },
    11155111: {
        mintLowSafe: '0x4b731EF14788f7371fAC837860Ed7bF2030344d2',
        mintHighSafe: '0x8aead919E7716a0840cB84495fA1AC76e04f7845',
    },
}

// Chains that are always production, whatever the config says.
const MAINNET_CHAIN_IDS = [1, 8453, 10, 42161, 137, 56, 43114]

const SAFE_ABI = [
    'function getOwners() view returns (address[])',
    'function getThreshold() view returns (uint256)',
    'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
]
const SAFE_VERSIONS = ['1.3.0', '1.4.1', '1.5.0']
// keccak256 of the SafeProxy runtime code each official factory deploys. v1.3.0 from the factories'
// proxyRuntimeCode(); v1.4.1 and v1.5.0 by simulating proxyCreationCode() (v1.4.1 matches the reference Safes).
const SAFE_PROXY_CODE_HASHES = [
    '0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000', // v1.3.0
    '0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c', // v1.4.1
    '0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f', // v1.5.0
]
const SAFE_SENTINEL = '0x0000000000000000000000000000000000000001'
const SAFE_GUARD_SLOT = ethers.utils.id('guard_manager.guard.address')
// v1.5.0 only; always zero on older versions.
const SAFE_MODULE_GUARD_SLOT = ethers.utils.id('module_manager.module_guard.address')

const PROXY_ADMIN_NAME = 'wTARIProxyAdmin'
const DEFAULT_ADMIN_ROLE = ethers.constants.HashZero
const MINTER_ROLE = ethers.utils.id('MINTER_ROLE')
const LOW_MINTER_ROLE = ethers.utils.id('LOW_MINTER_ROLE')
const HIGH_MINTER_ROLE = ethers.utils.id('HIGH_MINTER_ROLE')
const ROLE_NAMES: { [role: string]: string } = {
    [DEFAULT_ADMIN_ROLE]: 'DEFAULT_ADMIN_ROLE',
    [MINTER_ROLE]: 'MINTER_ROLE',
    [LOW_MINTER_ROLE]: 'LOW_MINTER_ROLE',
    [HIGH_MINTER_ROLE]: 'HIGH_MINTER_ROLE',
}
// EIP-1967 storage slots
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

const EVENTS = new ethers.utils.Interface([
    'event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',
    'event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)',
    'event PeerSet(uint32 eid, bytes32 peer)',
    'event EnforcedOptionSet(tuple(uint32 eid, uint16 msgType, bytes options)[] _enforcedOptions)',
    'event Transfer(address indexed from, address indexed to, uint256 value)',
])
// Many RPCs cap eth_getLogs ranges, so logs are fetched in chunks, halved on a range/size error.
const LOG_BLOCK_RANGE = 10_000
const MIN_LOG_BLOCK_RANGE = 100
// Emitted by a Safe (v1.3+) for every successful Safe transaction.
const SAFE_EXECUTION_SUCCESS = ethers.utils.id('ExecutionSuccess(bytes32,uint256)')

/** Official Safe and SafeL2 singletons for `chainId`, from @safe-global/safe-deployments (lowercase). */
export function safeSingletons(chainId: number): string[] {
    // The local hardhat network is not listed; it uses Ethereum mainnet's set.
    const network = chainId === 31337 ? '1' : String(chainId)
    const singletons: string[] = []
    for (const version of SAFE_VERSIONS) {
        for (const deployment of [
            getSafeSingletonDeployments({ version }),
            getSafeL2SingletonDeployments({ version }),
        ]) {
            const addresses = deployment?.networkAddresses[network] ?? []
            for (const address of Array.isArray(addresses) ? addresses : [addresses]) {
                singletons.push(address.toLowerCase())
            }
        }
    }
    return singletons
}

const CONFIG_DIR = path.join(__dirname, '..', 'deploy', 'wtari')
const RPC_ENV_PATTERN = /^[A-Z0-9_]+_RPC_URL$/

export function readWtariConfig(chainId: number): WtariChainConfig {
    const config: WtariChainConfig = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, `${chainId}.json`), 'utf8'))
    const file = `deploy/wtari/${chainId}.json`
    // A JSON number could lose precision before parseEther, so only a whole-token decimal string is accepted.
    if (typeof config.lowMintDailyLimit !== 'string' || !/^[0-9]+$/.test(config.lowMintDailyLimit)) {
        throw new Error(`${file}: "lowMintDailyLimit" must be a string of whole tokens, e.g. "500000"`)
    }
    // The config picks env var names and URLs, so keep it from routing secrets anywhere else.
    for (const name of [config.network.rpcUrlEnv, config.referenceRpcUrlEnv]) {
        if (!RPC_ENV_PATTERN.test(name)) {
            throw new Error(`${file}: RPC env var ${name} must match ${RPC_ENV_PATTERN}`)
        }
    }
    // Production protections (KMS, explicit RPC) must not be lost to a missing field, and only
    // mainnet chains compare against the Ethereum mainnet Safes.
    if (typeof config.production !== 'boolean') {
        throw new Error(`${file}: "production" must be true or false`)
    }
    if (MAINNET_CHAIN_IDS.includes(chainId) && !config.production) {
        throw new Error(`${file}: chain ${chainId} is a mainnet, so "production" must be true`)
    }
    if (config.production !== (config.referenceChainId === 1)) {
        throw new Error(`${file}: "production" must be true exactly when referenceChainId is 1 (Ethereum mainnet)`)
    }
    if (config.explorer) {
        const url = new URL(config.explorer.apiURL)
        if (url.protocol !== 'https:' || url.host !== 'api.etherscan.io') {
            throw new Error(`${file}: explorer.apiURL must be https://api.etherscan.io/...`)
        }
        if (url.searchParams.get('chainid') !== String(chainId)) {
            throw new Error(`${file}: explorer.apiURL must have chainid=${chainId}`)
        }
    }
    return config
}

/** Every deploy/wtari/<chainId>.json, as [chainId, config] pairs. */
export function listWtariConfigs(): [number, WtariChainConfig][] {
    const configs: [number, WtariChainConfig][] = []
    for (const file of fs.readdirSync(CONFIG_DIR)) {
        if (file.endsWith('.json')) {
            const chainId = Number(path.basename(file, '.json'))
            configs.push([chainId, readWtariConfig(chainId)])
        }
    }
    return configs
}

async function checkHasCode(provider: providers.Provider, label: string, address: string) {
    if ((await provider.getCode(address)) === '0x') {
        throw new Error(`${label} ${address} has no code on the target chain`)
    }
}

/**
 * Official SafeProxy code, official singleton, no modules, no guards; owners/threshold equal to the
 * reference Safe if given. Returns the threshold.
 */
async function checkSafe(
    provider: providers.Provider,
    label: string,
    safe: string,
    referenceProvider?: providers.Provider,
    referenceSafe?: string
) {
    await checkHasCode(provider, label, safe)
    if (!SAFE_PROXY_CODE_HASHES.includes(ethers.utils.keccak256(await provider.getCode(safe)))) {
        throw new Error(`${label} ${safe} is not an official SafeProxy (runtime code hash mismatch)`)
    }
    const target = new Contract(safe, SAFE_ABI, provider)

    const singleton = ethers.utils.hexDataSlice(await provider.getStorageAt(safe, 0), 12)
    const { chainId } = await provider.getNetwork()
    if (!safeSingletons(chainId).includes(singleton.toLowerCase())) {
        throw new Error(`${label} ${safe} singleton ${singleton} is not an official Safe singleton on chain ${chainId}`)
    }
    const [modules] = await target.getModulesPaginated(SAFE_SENTINEL, 10)
    if (modules.length > 0) {
        throw new Error(`${label} ${safe} has modules enabled: ${modules.join(', ')}`)
    }
    if (!ethers.BigNumber.from(await provider.getStorageAt(safe, SAFE_GUARD_SLOT)).isZero()) {
        throw new Error(`${label} ${safe} has a transaction guard set`)
    }
    if (!ethers.BigNumber.from(await provider.getStorageAt(safe, SAFE_MODULE_GUARD_SLOT)).isZero()) {
        throw new Error(`${label} ${safe} has a module guard set`)
    }

    const threshold = await target.getThreshold()
    if (!referenceProvider || !referenceSafe) return threshold
    const reference = new Contract(referenceSafe, SAFE_ABI, referenceProvider)
    const owners = (await target.getOwners()).map((a: string) => a.toLowerCase()).sort()
    const referenceOwners = (await reference.getOwners()).map((a: string) => a.toLowerCase()).sort()
    if (owners.join(',') !== referenceOwners.join(',')) {
        throw new Error(`${label} ${safe} owners differ from reference Safe ${referenceSafe}`)
    }
    const referenceThreshold = await reference.getThreshold()
    if (!threshold.eq(referenceThreshold)) {
        throw new Error(
            `${label} ${safe} threshold ${threshold} differs from reference Safe threshold ${referenceThreshold}`
        )
    }
    return threshold
}

async function checkSafes(
    provider: providers.Provider,
    referenceProvider: providers.Provider,
    config: WtariChainConfig
) {
    const reference = REFERENCE_SAFES[config.referenceChainId]
    if (!reference) throw new Error(`No reference Safes for referenceChainId ${config.referenceChainId}`)
    if ((await referenceProvider.getNetwork()).chainId !== config.referenceChainId) {
        throw new Error(`Reference provider is not on chain ${config.referenceChainId}`)
    }
    await checkSafe(provider, 'mintLowSafe', config.mintLowSafe, referenceProvider, reference.mintLowSafe)
    await checkSafe(provider, 'mintHighSafe', config.mintHighSafe, referenceProvider, reference.mintHighSafe)
    const adminThreshold = await checkSafe(provider, 'proxyAdminOwner', config.proxyAdminOwner)

    const low = config.mintLowSafe.toLowerCase()
    const high = config.mintHighSafe.toLowerCase()
    const admin = config.proxyAdminOwner.toLowerCase()
    if (low === high) throw new Error('mintLowSafe and mintHighSafe must be different Safes')
    if (admin === low || admin === high) throw new Error('proxyAdminOwner must differ from both mint Safes')
    if (adminThreshold.lt(2)) throw new Error(`proxyAdminOwner threshold ${adminThreshold} must be at least 2`)
}

/** Roles and ownership `account` holds on wTARI / wTARIController / wTARIProxyAdmin. */
async function heldControl(token: Contract, controller: Contract, proxyAdmin: Contract, account: string) {
    const held: string[] = []
    for (const [name, contract] of [
        ['wTARI', token],
        ['wTARIController', controller],
    ] as const) {
        for (const role of Object.keys(ROLE_NAMES)) {
            if (await contract.hasRole(role, account)) held.push(`${name} ${ROLE_NAMES[role]}`)
        }
    }
    for (const [name, contract] of [
        ['wTARI', token],
        [PROXY_ADMIN_NAME, proxyAdmin],
    ] as const) {
        if ((await contract.owner()).toLowerCase() === account.toLowerCase()) held.push(`${name} owner`)
    }
    return held
}

// CREATE2 salts; each contract's implementation and proxy use its salt, wTARIProxyAdmin uses wTARI's.
export const SALTS = {
    wTARI: ethers.utils.id('wTARI-v0.0.1'),
    wTARIController: ethers.utils.id('wTARIController-v0.0.1'),
    wTARIBridge: ethers.utils.id('wTARIBridge-v0.0.1'),
}

/** initialize() arguments of the three proxies, shared by deployWtari and check:wtari so they cannot drift. */
export function tokenInitializeArgs(config: WtariChainConfig) {
    return ['WrappedTARI', 'wTARI', '1', config.proxyAdminOwner]
}

/** initialize() arguments of the controller and bridge proxies, which point at the wTARI proxy. */
export function initializeArgs(config: WtariChainConfig, tokenAddress: string) {
    return {
        wTARIController: [
            tokenAddress,
            config.mintLowSafe,
            config.mintHighSafe,
            config.proxyAdminOwner,
            ethers.utils.parseEther(config.lowMintDailyLimit),
        ],
        wTARIBridge: [tokenAddress],
    }
}

/** The pending grantRole(MINTER_ROLE, controller) transaction the proxyAdminOwner Safe must execute. */
export function minterGrantTransaction(tokenAddress: string, controllerAddress: string): SafeTransaction {
    return {
        to: tokenAddress,
        value: '0',
        operation: 0,
        data: new ethers.utils.Interface(['function grantRole(bytes32 role, address account)']).encodeFunctionData(
            'grantRole',
            [MINTER_ROLE, controllerAddress]
        ),
        description: `wTARI proxy ${tokenAddress} .grantRole(MINTER_ROLE ${MINTER_ROLE}, wTARIController proxy ${controllerAddress})`,
    }
}

/** EIP-712 safeTxHash (Safe v1.3+) of `tx` with all gas/refund fields zero, for `nonce` on `safe`. */
export function safeTxHash(tx: SafeTransaction, safe: string, chainId: number, nonce: number) {
    return ethers.utils._TypedDataEncoder.hash(
        { chainId, verifyingContract: safe },
        {
            SafeTx: [
                { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'data', type: 'bytes' },
                { name: 'operation', type: 'uint8' },
                { name: 'safeTxGas', type: 'uint256' },
                { name: 'baseGas', type: 'uint256' },
                { name: 'gasPrice', type: 'uint256' },
                { name: 'gasToken', type: 'address' },
                { name: 'refundReceiver', type: 'address' },
                { name: 'nonce', type: 'uint256' },
            ],
        },
        {
            to: tx.to,
            value: tx.value,
            data: tx.data,
            operation: tx.operation,
            safeTxGas: 0,
            baseGas: 0,
            gasPrice: 0,
            gasToken: ethers.constants.AddressZero,
            refundReceiver: ethers.constants.AddressZero,
            nonce,
        }
    )
}

export function printSafeTransaction(safe: string, tx: SafeTransaction, chainId: number, nonce?: number) {
    console.log(`Pending Safe transaction for proxyAdminOwner ${safe} on chain ${chainId}:`)
    console.log(`  to:             ${tx.to}`)
    console.log(`  value:          ${tx.value}`)
    console.log(`  data:           ${tx.data}`)
    console.log(`  operation:      ${tx.operation} (CALL)`)
    console.log('  safeTxGas:      0')
    console.log('  baseGas:        0')
    console.log('  gasPrice:       0')
    console.log(`  gasToken:       ${ethers.constants.AddressZero}`)
    console.log(`  refundReceiver: ${ethers.constants.AddressZero}`)
    console.log(`  what:           ${tx.description}`)
    if (nonce !== undefined) {
        console.log(`  safeTxHash (nonce ${nonce}): ${safeTxHash(tx, safe, chainId, nonce)}`)
    } else {
        console.log('  (pass --safe-nonce <n> to also print the safeTxHash to compare on the hardware wallet)')
    }
}

/**
 * Deploys the three proxies with the proxyAdminOwner Safe as owner, LZ delegate and admin from the first
 * block. Returns the Safe transaction still needed to grant the controller MINTER_ROLE, if any.
 */
export async function deployWtari(
    hre: HardhatRuntimeEnvironment,
    config: WtariChainConfig,
    lzEndpoint: string,
    referenceProvider: providers.Provider
): Promise<SafeTransaction | undefined> {
    const { deploy, read } = hre.deployments
    const provider = hre.ethers.provider

    // Before any transaction: a production chain must not deploy through the public fallback RPC.
    assertProductionRpc(config)
    await checkSafes(provider, referenceProvider, config)
    await checkHasCode(provider, 'LayerZero endpoint', lzEndpoint)

    const { deployer } = await hre.getNamedAccounts()
    console.log(`Network: ${hre.network.name}`)
    console.log(`Deployer: ${deployer}`)

    // All three proxies share one wTARI-specific admin owned by the proxyAdminOwner Safe.
    // The token deploy creates it; the controller and bridge reuse that deployment.
    const proxy = {
        proxyContract: 'OpenZeppelinTransparentProxy',
        owner: config.proxyAdminOwner,
        viaAdminContract: { name: PROXY_ADMIN_NAME },
    }

    const token = await deploy('wTARI', {
        from: deployer,
        args: [lzEndpoint],
        deterministicDeployment: SALTS.wTARI,
        log: true,
        waitConfirmations: config.confirmations,
        proxy: {
            ...proxy,
            viaAdminContract: { name: PROXY_ADMIN_NAME, artifact: ProxyAdmin },
            execute: { init: { methodName: 'initialize', args: tokenInitializeArgs(config) } },
        },
    })

    const controller = await deploy('wTARIController', {
        from: deployer,
        args: [],
        deterministicDeployment: SALTS.wTARIController,
        log: true,
        waitConfirmations: config.confirmations,
        proxy: {
            ...proxy,
            execute: {
                init: { methodName: 'initialize', args: initializeArgs(config, token.address).wTARIController },
            },
        },
    })

    const bridge = await deploy('wTARIBridge', {
        from: deployer,
        args: [],
        deterministicDeployment: SALTS.wTARIBridge,
        log: true,
        waitConfirmations: config.confirmations,
        proxy: {
            ...proxy,
            execute: { init: { methodName: 'initialize', args: initializeArgs(config, token.address).wTARIBridge } },
        },
    })

    console.log(`wTARI: ${token.address} (implementation ${token.implementation})`)
    console.log(`wTARIController: ${controller.address} (implementation ${controller.implementation})`)
    console.log(`wTARIBridge: ${bridge.address} (implementation ${bridge.implementation})`)

    // Only the Safe holds wTARI admin, so only the Safe can let the controller mint.
    if (await read('wTARI', 'hasRole', MINTER_ROLE, controller.address)) return undefined
    return minterGrantTransaction(token.address, controller.address)
}

/**
 * Raw logs of `addresses` matching `topics` from `fromBlock` to the latest block, oldest first. Uses
 * eth_getLogs directly so one query can cover several addresses.
 */
export async function fetchLogs(
    provider: Pick<providers.JsonRpcProvider, 'getBlockNumber' | 'send'>,
    addresses: string[],
    fromBlock: number,
    topics: (string | string[])[]
) {
    const latest = await provider.getBlockNumber()
    const logs: providers.Log[] = []
    let range = LOG_BLOCK_RANGE
    let start = fromBlock
    while (start <= latest) {
        const toBlock = Math.min(start + range - 1, latest)
        try {
            const chunk: providers.Log[] = await provider.send('eth_getLogs', [
                {
                    address: addresses,
                    topics,
                    fromBlock: ethers.utils.hexValue(start),
                    toBlock: ethers.utils.hexValue(toBlock),
                },
            ])
            logs.push(...chunk)
            start = toBlock + 1
        } catch (e) {
            const tooLarge = /range|limit|too many|exceed|size/i.test((e as Error).message)
            if (!tooLarge || range <= MIN_LOG_BLOCK_RANGE) throw e
            range = Math.max(MIN_LOG_BLOCK_RANGE, Math.floor(range / 2))
        }
    }
    return logs
}

/** Fetches transaction receipts, at most 8 at a time. */
async function fetchReceipts(provider: providers.Provider, hashes: string[]) {
    const receipts: providers.TransactionReceipt[] = []
    for (let i = 0; i < hashes.length; i += 8) {
        receipts.push(
            ...(await Promise.all(hashes.slice(i, i + 8).map((hash) => provider.getTransactionReceipt(hash))))
        )
    }
    return receipts
}

/**
 * Every RoleGranted ever emitted must be for an expected [role, account] pair (a grant later revoked still
 * counts), and every expected pair must be held according to the replayed events.
 */
function compareRoleHolders(name: string, events: ethers.utils.LogDescription[], expected: [string, string][]) {
    const wanted = new Set(expected.map(([role, account]) => `${role}:${account.toLowerCase()}`))
    const holders = new Set<string>()
    const failures: string[] = []
    for (const event of events) {
        const key = `${event.args.role}:${event.args.account?.toLowerCase()}`
        if (event.name === 'RoleGranted') {
            holders.add(key)
            if (!wanted.has(key)) {
                const role = ROLE_NAMES[event.args.role] ?? event.args.role
                failures.push(`${name}: ${role} was granted to ${event.args.account}, which is not an expected holder`)
            }
        }
        if (event.name === 'RoleRevoked') holders.delete(key)
    }
    for (const key of wanted) {
        const [role, account] = key.split(':')
        if (!holders.has(key)) failures.push(`${name}: no RoleGranted event for ${ROLE_NAMES[role]} to ${account}`)
    }
    return failures
}

/** The creation transaction of a deployment record, read from the chain (not from the record). */
async function creationTransaction(
    provider: providers.Provider,
    name: string,
    transactionHash: string | undefined,
    expected: ExpectedCreation
) {
    const tx = transactionHash ? await provider.getTransaction(transactionHash) : null
    if (!tx || tx.blockNumber == null) {
        throw new Error(`${name}: creation transaction ${transactionHash} not found on chain`)
    }
    // A forged record hash must not move the deployer or the replay start block.
    const expectedData = ethers.utils.hexConcat([expected.salt, expected.initCode]).toLowerCase()
    if (tx.to?.toLowerCase() !== CREATE2_FACTORY || tx.data.toLowerCase() !== expectedData) {
        throw new Error(
            `${name}: transaction ${transactionHash} did not create ${expected.address} through the CREATE2 factory`
        )
    }
    // A reverted duplicate call with the same data would otherwise match.
    if ((await provider.getTransactionReceipt(tx.hash))?.status !== 1) {
        throw new Error(`${name}: creation transaction ${transactionHash} did not succeed`)
    }
    return { from: tx.from, blockNumber: tx.blockNumber }
}

/** Zeroes the immutable ranges of a runtime bytecode so it can be compared with the compiled one. */
function maskImmutables(code: string, immutableReferences: { [id: string]: { start: number; length: number }[] }) {
    const bytes = ethers.utils.arrayify(code)
    for (const ranges of Object.values(immutableReferences)) {
        for (const { start, length } of ranges) bytes.fill(0, start, start + length)
    }
    return ethers.utils.hexlify(bytes)
}

type ImmutableReferences = { [id: string]: { start: number; length: number }[] }

/** Compiled runtime bytecode, immutable references and storage slots of one of our contracts. */
async function compiledContract(hre: HardhatRuntimeEnvironment, contractName: string) {
    const sourceName = `contracts/${contractName}.sol`
    const buildInfo = await hre.artifacts.getBuildInfo(`${sourceName}:${contractName}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = buildInfo?.output.contracts[sourceName][contractName] as any
    if (!output) throw new Error(`No build info for ${sourceName}:${contractName}; run hardhat compile`)
    const slots: { [label: string]: string } = {}
    // storageLayout gives decimal slot strings; getStorageAt needs a number or hex.
    for (const entry of output.storageLayout.storage)
        slots[entry.label] = ethers.BigNumber.from(entry.slot).toHexString()
    const immutableReferences = (output.evm.deployedBytecode.immutableReferences ?? {}) as ImmutableReferences
    const asts = Object.values(buildInfo?.output.sources ?? {}).map((source) => source.ast)
    const immutableNames = Object.keys(immutableReferences).map((id) => declarationName(asts, Number(id)) ?? `#${id}`)
    return { code: `0x${output.evm.deployedBytecode.object}`, immutableReferences, immutableNames, slots }
}

async function sameRuntimeCode(
    provider: providers.Provider,
    address: string,
    compiledCode: string,
    immutableReferences: ImmutableReferences
) {
    const onChain = await provider.getCode(address)
    return maskImmutables(onChain, immutableReferences) === maskImmutables(compiledCode, immutableReferences)
}

// Pinned EndpointV2 per LayerZero eid, with the chain id that eid belongs to. A new chain needs a pin here.
const LZ_ENDPOINTS: { [eid: number]: { chainId: number; endpoint: string } } = {
    30101: { chainId: 1, endpoint: '0x1a44076050125825900e736c501f859c50fE728c' },
    40161: { chainId: 11155111, endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f' },
    30184: { chainId: 8453, endpoint: '0x1a44076050125825900e736c501f859c50fE728c' },
    40245: { chainId: 84532, endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f' },
}

/** The official EndpointV2 for `eid` on `chainId`: the pin, which the LayerZero package must agree with. */
export function officialLzEndpoint(eid: number, chainId: number) {
    const pin = LZ_ENDPOINTS[eid]
    if (!pin)
        throw new Error(
            `No pinned LayerZero endpoint for eid ${eid}: pin the endpoint for eid ${eid} in tasks/wtari.ts`
        )
    if (pin.chainId !== chainId)
        throw new Error(`LayerZero eid ${eid} belongs to chain ${pin.chainId}, not chain ${chainId}`)
    const packaged = getDeploymentAddressAndAbi(endpointIdToNetwork(eid as EndpointId), 'EndpointV2').address
    if (packaged.toLowerCase() !== pin.endpoint.toLowerCase()) {
        throw new Error(
            `@layerzerolabs/lz-evm-sdk-v2 endpoint ${packaged} for eid ${eid} differs from the pin ${pin.endpoint}`
        )
    }
    return pin.endpoint
}

// Arachnid's deterministic-deployment-proxy, hardhat-deploy's default CREATE2 factory (calldata = salt ‖ initcode).
const CREATE2_FACTORY = '0x4e59b44847b379578588920ca78fbf26c0b4956c'
// Immutables per implementation; each is masked in the bytecode comparison and checked via its getter.
const CHECKED_IMMUTABLES: { [contractName: string]: string[] } = {
    wTARI: ['endpoint', 'decimalConversionRate'],
}
const CREATE2_FACTORY_RUNTIME =
    '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3'

interface ExpectedCreation {
    address: string
    salt: string
    initCode: string
}

function create2(salt: string, initCode: string): ExpectedCreation {
    const address = ethers.utils.getCreate2Address(CREATE2_FACTORY, salt, ethers.utils.keccak256(initCode))
    return { address, salt, initCode }
}

// The hardhat-deploy records deploy:wtari creates; exactly these are exported to the package.
export const WTARI_RECORD_NAMES = [
    PROXY_ADMIN_NAME,
    'wTARI',
    'wTARI_Proxy',
    'wTARI_Implementation',
    'wTARIController',
    'wTARIController_Proxy',
    'wTARIController_Implementation',
    'wTARIBridge',
    'wTARIBridge_Proxy',
    'wTARIBridge_Implementation',
] as const

/** Every wTARI deployment record's CREATE2 address, recomputed from compiled code, salts and config. */
export async function expectedWtariCreations(
    hre: HardhatRuntimeEnvironment,
    config: WtariChainConfig,
    lzEndpoint: string
) {
    const coder = ethers.utils.defaultAbiCoder
    const proxyInitCode = (implementation: string, admin: string, abi: unknown[], args: unknown[]) =>
        ethers.utils.hexConcat([
            TransparentUpgradeableProxy.bytecode,
            coder.encode(
                ['address', 'address', 'bytes'],
                [
                    implementation,
                    admin,
                    new ethers.utils.Interface(abi as string[]).encodeFunctionData('initialize', args),
                ]
            ),
        ])
    const tokenArtifact = await hre.artifacts.readArtifact('wTARI')
    const controllerArtifact = await hre.artifacts.readArtifact('wTARIController')
    const bridgeArtifact = await hre.artifacts.readArtifact('wTARIBridge')

    const admin = create2(
        SALTS.wTARI,
        ethers.utils.hexConcat([ProxyAdmin.bytecode, coder.encode(['address'], [config.proxyAdminOwner])])
    )
    const tokenImplementation = create2(
        SALTS.wTARI,
        ethers.utils.hexConcat([tokenArtifact.bytecode, coder.encode(['address'], [lzEndpoint])])
    )
    const token = create2(
        SALTS.wTARI,
        proxyInitCode(tokenImplementation.address, admin.address, tokenArtifact.abi, tokenInitializeArgs(config))
    )
    const args = initializeArgs(config, token.address)
    const controllerImplementation = create2(SALTS.wTARIController, controllerArtifact.bytecode)
    const controller = create2(
        SALTS.wTARIController,
        proxyInitCode(controllerImplementation.address, admin.address, controllerArtifact.abi, args.wTARIController)
    )
    const bridgeImplementation = create2(SALTS.wTARIBridge, bridgeArtifact.bytecode)
    const bridge = create2(
        SALTS.wTARIBridge,
        proxyInitCode(bridgeImplementation.address, admin.address, bridgeArtifact.abi, args.wTARIBridge)
    )
    return {
        [PROXY_ADMIN_NAME]: admin,
        wTARI: token,
        wTARI_Proxy: token,
        wTARI_Implementation: tokenImplementation,
        wTARIController: controller,
        wTARIController_Proxy: controller,
        wTARIController_Implementation: controllerImplementation,
        wTARIBridge: bridge,
        wTARIBridge_Proxy: bridge,
        wTARIBridge_Implementation: bridgeImplementation,
    }
}

/** Name of the state variable with AST id `id`, searched through the build's source ASTs. */
function declarationName(node: unknown, id: number): string | undefined {
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = declarationName(child, id)
            if (found) return found
        }
    } else if (node && typeof node === 'object') {
        const declaration = node as { id?: number; nodeType?: string; name?: string }
        if (declaration.id === id && declaration.nodeType === 'VariableDeclaration') return declaration.name
        for (const value of Object.values(node)) {
            const found = declarationName(value, id)
            if (found) return found
        }
    }
    return undefined
}

function missingGrantMessage(tokenAddress: string, controllerAddress: string) {
    const tx = minterGrantTransaction(tokenAddress, controllerAddress)
    return (
        `wTARI: the controller does not have MINTER_ROLE yet; execute this Safe transaction from proxyAdminOwner: ` +
        `to ${tx.to}, value ${tx.value}, data ${tx.data} (${tx.description})`
    )
}

/** Immutables of `contractName` that check:wtari does not check through a getter. */
export function uncheckedImmutables(contractName: string, immutableNames: string[]) {
    return immutableNames.filter((name) => !(CHECKED_IMMUTABLES[contractName] ?? []).includes(name))
}

/** Post-deploy review of Safes, roles, ownership, LZ config, bytecode and proxy slots. */
export async function checkWtariDeployment(
    hre: HardhatRuntimeEnvironment,
    config: WtariChainConfig,
    referenceProvider: providers.Provider,
    options: {
        // Only for the local hardhat network, where the endpoint is a mock.
        expectedLzEndpoint?: string
        // deploy:wtari before the Safe grants the controller MINTER_ROLE: that grant may be missing.
        preGrant?: boolean
    } = {}
) {
    const { get } = hre.deployments
    const provider = hre.ethers.provider
    const failures: string[] = []
    const { chainId } = await provider.getNetwork()
    assertProductionRpc(config)
    const expectedLzEndpoint = options.expectedLzEndpoint ?? officialLzEndpoint(config.network.eid, chainId)

    await checkSafes(provider, referenceProvider, config)

    // Every record must be at the CREATE2 address implied by our compiled code, salts and config. CREATE2 ties
    // the address to the exact creation code, so nothing else can have run at construction.
    if ((await provider.getCode(CREATE2_FACTORY)).toLowerCase() !== CREATE2_FACTORY_RUNTIME) {
        throw new Error(`CREATE2 factory ${CREATE2_FACTORY} does not have the deterministic-deployment-proxy code`)
    }
    const expected = await expectedWtariCreations(hre, config, expectedLzEndpoint)
    for (const [name, creation] of Object.entries(expected)) {
        const record = await get(name)
        if (record.address.toLowerCase() !== creation.address.toLowerCase()) {
            throw new Error(
                `${name}: record address ${record.address} is not the expected CREATE2 address ${creation.address}`
            )
        }
    }

    // From here on, every read goes through compiled ABIs at the CREATE2-proven addresses.
    const token = new Contract(expected.wTARI.address, (await hre.artifacts.readArtifact('wTARI')).abi, provider)
    const controller = new Contract(
        expected.wTARIController.address,
        (await hre.artifacts.readArtifact('wTARIController')).abi,
        provider
    )
    const bridge = { address: expected.wTARIBridge.address }
    const proxyAdmin = new Contract(expected[PROXY_ADMIN_NAME].address, ProxyAdmin.abi, provider)
    const roleContracts: { [name: string]: Contract } = { wTARI: token, wTARIController: controller }
    const minterGranted: boolean = await token.hasRole(MINTER_ROLE, controller.address)
    // Computed from the proven addresses, so signers can compare the queued Safe tx byte for byte. It is only
    // returned (for the caller to print) once the whole check has passed.
    const pendingSafeTransaction =
        !minterGranted && options.preGrant ? minterGrantTransaction(token.address, controller.address) : undefined

    const expectedRoles: [string, string, string][] = [
        ...(minterGranted || !options.preGrant
            ? [['wTARI', MINTER_ROLE, controller.address] as [string, string, string]]
            : []),
        ['wTARI', DEFAULT_ADMIN_ROLE, config.proxyAdminOwner],
        ['wTARIController', LOW_MINTER_ROLE, config.mintLowSafe],
        ['wTARIController', HIGH_MINTER_ROLE, config.mintHighSafe],
        ['wTARIController', DEFAULT_ADMIN_ROLE, config.proxyAdminOwner],
    ]
    for (const [name, role, account] of expectedRoles) {
        if (!(await roleContracts[name].hasRole(role, account))) {
            failures.push(
                role === MINTER_ROLE
                    ? missingGrantMessage(token.address, controller.address)
                    : `${name}: ${account} is missing ${ROLE_NAMES[role]}`
            )
        }
        if ((await provider.getCode(account)) === '0x') {
            failures.push(`${name}: ${ROLE_NAMES[role]} holder ${account} has no code`)
        }
    }

    // The deployer and start blocks come from the proven, successful creation transactions.
    const proxyCreation = async (name: 'wTARI' | 'wTARIController' | 'wTARIBridge') =>
        creationTransaction(provider, name, (await get(`${name}_Proxy`)).transactionHash, expected[name])
    const tokenCreation = await proxyCreation('wTARI')
    const controllerCreation = await proxyCreation('wTARIController')
    const bridgeCreation = await proxyCreation('wTARIBridge')
    const accounts = [tokenCreation.from]
    try {
        accounts.push((await hre.getNamedAccounts()).deployer)
    } catch {
        console.log('No signer available; checking only the deployer from the creation transaction')
    }
    for (const account of accounts) {
        if (!account) continue
        for (const held of await heldControl(token, controller, proxyAdmin, account)) {
            failures.push(`deployer ${account} holds ${held}`)
        }
    }

    const owner = await token.owner()
    if (owner.toLowerCase() !== config.proxyAdminOwner.toLowerCase()) {
        failures.push(`wTARI: owner ${owner} is not proxyAdminOwner ${config.proxyAdminOwner}`)
    }
    if ((await proxyAdmin.owner()).toLowerCase() !== config.proxyAdminOwner.toLowerCase()) {
        failures.push(`${PROXY_ADMIN_NAME}: owner is not proxyAdminOwner ${config.proxyAdminOwner}`)
    }
    // The endpoint is an immutable masked in the bytecode comparison, so check it via the getter.
    const lzEndpoint = await token.endpoint()
    if (lzEndpoint.toLowerCase() !== expectedLzEndpoint.toLowerCase()) {
        failures.push(`wTARI: endpoint() ${lzEndpoint} is not the official LayerZero endpoint ${expectedLzEndpoint}`)
    } else {
        const endpoint = new Contract(lzEndpoint, ['function delegates(address) view returns (address)'], provider)
        const delegate = await endpoint.delegates(token.address)
        if (delegate.toLowerCase() !== config.proxyAdminOwner.toLowerCase()) {
            failures.push(`wTARI: LayerZero delegate ${delegate} is not proxyAdminOwner ${config.proxyAdminOwner}`)
        }
    }
    for (const getter of ['msgInspector', 'preCrime']) {
        const value = await token[getter]()
        if (value !== ethers.constants.AddressZero) failures.push(`wTARI: ${getter} is set to ${value}`)
    }

    // Two scans in total: role / peer / enforced-option events of both contracts, and wTARI mints.
    const fromBlock = Math.min(tokenCreation.blockNumber, controllerCreation.blockNumber)
    const eventTopics = [
        ['RoleGranted', 'RoleRevoked', 'PeerSet', 'EnforcedOptionSet'].map((n) => EVENTS.getEventTopic(n)),
    ]
    const eventLogs = await fetchLogs(provider, [token.address, controller.address], fromBlock, eventTopics)
    const eventsOf = (address: string) =>
        eventLogs
            .filter((log) => log.address.toLowerCase() === address.toLowerCase())
            .map((log) => EVENTS.parseLog(log))
    const tokenEvents = eventsOf(token.address)
    const controllerEvents = eventsOf(controller.address)
    failures.push(
        ...compareRoleHolders(
            'wTARI',
            tokenEvents,
            expectedRoles.filter(([name]) => name === 'wTARI').map(([, role, account]) => [role, account])
        ),
        ...compareRoleHolders(
            'wTARIController',
            controllerEvents,
            expectedRoles.filter(([name]) => name === 'wTARIController').map(([, role, account]) => [role, account])
        )
    )
    const minterGrants = tokenEvents.filter((e) => e.name === 'RoleGranted' && e.args.role === MINTER_ROLE)
    if (minterGrants.length !== (minterGranted ? 1 : 0)) {
        failures.push(
            `wTARI: MINTER_ROLE was granted ${minterGrants.length} times; expected exactly once, to the controller`
        )
    }
    // Every mint must be in a transaction where a mint Safe executed (ExecutionSuccess), also when relayed.
    const mintTopics = [EVENTS.getEventTopic('Transfer'), ethers.utils.hexZeroPad('0x', 32)]
    const mintSafes = [config.mintLowSafe.toLowerCase(), config.mintHighSafe.toLowerCase()]
    const mintLogs = await fetchLogs(provider, [token.address], tokenCreation.blockNumber, mintTopics)
    const mintHashes = [...new Set(mintLogs.map((log) => log.transactionHash))]
    for (const receipt of await fetchReceipts(provider, mintHashes)) {
        const safeExecuted = receipt.logs.some(
            (log) => mintSafes.includes(log.address.toLowerCase()) && log.topics[0] === SAFE_EXECUTION_SUCCESS
        )
        if (!safeExecuted) {
            failures.push(`wTARI: mint in transaction ${receipt.transactionHash} was not part of a mint Safe execution`)
        }
    }
    for (const event of tokenEvents) {
        if (event.name === 'PeerSet') failures.push(`wTARI: PeerSet emitted for eid ${event.args.eid}`)
        if (event.name === 'EnforcedOptionSet') failures.push('wTARI: EnforcedOptionSet emitted')
    }

    // Bytecode is compared at the addresses the proxies actually use, read from their EIP-1967 slots.
    const proxyRefs = TransparentUpgradeableProxy.evm.deployedBytecode.immutableReferences
    const admins = new Set<string>()
    for (const [deployment, contractName] of [
        [token, 'wTARI'],
        [controller, 'wTARIController'],
        [bridge, 'wTARIBridge'],
    ] as const) {
        const admin = ethers.utils.hexDataSlice(await provider.getStorageAt(deployment.address, ADMIN_SLOT), 12)
        const implementation = ethers.utils.hexDataSlice(
            await provider.getStorageAt(deployment.address, IMPLEMENTATION_SLOT),
            12
        )
        console.log(`proxy ${deployment.address}: admin ${admin}, implementation ${implementation}`)
        admins.add(admin)
        if (admin.toLowerCase() !== proxyAdmin.address.toLowerCase()) {
            failures.push(
                `proxy ${deployment.address}: admin ${admin} is not ${PROXY_ADMIN_NAME} ${proxyAdmin.address}`
            )
        }
        const expectedImplementation = expected[`${contractName}_Implementation`].address
        if (implementation.toLowerCase() !== expectedImplementation.toLowerCase()) {
            failures.push(
                `proxy ${deployment.address}: implementation ${implementation} is not ${expectedImplementation}`
            )
        }
        if (
            !(await sameRuntimeCode(
                provider,
                deployment.address,
                TransparentUpgradeableProxy.deployedBytecode,
                proxyRefs
            ))
        ) {
            failures.push(
                `${contractName} proxy ${deployment.address}: runtime bytecode differs from the compiled artifact`
            )
        }
        const compiled = await compiledContract(hre, contractName)
        // Immutables are masked in the comparison, so each one must be checked through its getter below.
        for (const name of uncheckedImmutables(contractName, compiled.immutableNames)) {
            failures.push(`${contractName}: immutable ${name} is not checked by check:wtari`)
        }
        if (!(await sameRuntimeCode(provider, implementation, compiled.code, compiled.immutableReferences))) {
            failures.push(
                `${contractName} implementation ${implementation}: runtime bytecode differs from the compiled artifact`
            )
        }
    }
    for (const admin of admins) {
        const adminRefs = ProxyAdmin.evm.deployedBytecode.immutableReferences
        if (!(await sameRuntimeCode(provider, admin, ProxyAdmin.deployedBytecode, adminRefs))) {
            failures.push(`${PROXY_ADMIN_NAME} ${admin}: runtime bytecode differs from the compiled artifact`)
        }
    }

    // Initializer state the bytecode cannot show: both contracts must point at this wTARI proxy.
    for (const [deployment, contractName, label] of [
        [controller, 'wTARIController', 'wtari'],
        [bridge, 'wTARIBridge', 'wTARI'],
    ] as const) {
        const slot = (await compiledContract(hre, contractName)).slots[label]
        const pointer = ethers.utils.hexDataSlice(await provider.getStorageAt(deployment.address, slot), 12)
        if (pointer.toLowerCase() !== token.address.toLowerCase()) {
            failures.push(`${contractName}: token pointer ${pointer} is not the wTARI proxy ${token.address}`)
        }
    }

    for (const [name, refs] of [
        ['TransparentUpgradeableProxy', TransparentUpgradeableProxy.evm.deployedBytecode.immutableReferences],
        [PROXY_ADMIN_NAME, ProxyAdmin.evm.deployedBytecode.immutableReferences],
    ] as const) {
        if (Object.keys(refs).length > 0) failures.push(`${name}: has immutables that check:wtari does not check`)
    }

    // Token metadata and the EIP-712 domain used by receiveWithAuthorization.
    const decimals: number = await token.decimals()
    for (const [getter, value, wanted] of [
        ['name', await token.name(), 'WrappedTARI'],
        ['symbol', await token.symbol(), 'wTARI'],
        ['decimals', decimals, 18],
    ]) {
        if (value !== wanted) failures.push(`wTARI: ${getter}() is ${value}, not ${wanted}`)
    }
    const domain = await token.eip712Domain()
    if (
        domain.name !== 'wTARI' ||
        domain.version !== '1' ||
        !domain.chainId.eq(chainId) ||
        domain.verifyingContract.toLowerCase() !== token.address.toLowerCase()
    ) {
        failures.push(
            `wTARI: EIP-712 domain ${domain.name} ${domain.version} ${domain.chainId} ${domain.verifyingContract} is not wTARI 1 ${chainId} ${token.address}`
        )
    }
    const sharedDecimals: number = await token.sharedDecimals()
    const conversionRate = await token.decimalConversionRate()
    if (!conversionRate.eq(ethers.BigNumber.from(10).pow(decimals - sharedDecimals))) {
        failures.push(`wTARI: decimalConversionRate ${conversionRate} is not 10^(decimals - sharedDecimals)`)
    }

    // Before the controller can mint, nothing can have been minted.
    const totalSupply = await token.totalSupply()
    if (!minterGranted && !totalSupply.isZero()) {
        failures.push(`wTARI: totalSupply ${totalSupply} is not 0 before the controller holds MINTER_ROLE`)
    }
    console.log(`wTARI totalSupply: ${ethers.utils.formatEther(totalSupply)}`)

    const limit = await controller.lowMintDailyLimit()
    if (!limit.eq(ethers.utils.parseEther(config.lowMintDailyLimit))) {
        failures.push(
            `wTARIController: lowMintDailyLimit ${ethers.utils.formatEther(limit)} is not ${config.lowMintDailyLimit}`
        )
    }

    if (failures.length > 0) {
        throw new Error(`wTARI deployment check failed:\n${failures.join('\n')}`)
    }
    console.log('wTARI deployment check passed')
    return { bridgeStartBlock: bridgeCreation.blockNumber, pendingSafeTransaction }
}

// Every contract deploy:wtari creates, by hardhat-deploy record name.
const VERIFY_NAMES = [
    'wTARI_Implementation',
    'wTARIController_Implementation',
    'wTARIBridge_Implementation',
    'wTARI_Proxy',
    'wTARIController_Proxy',
    'wTARIBridge_Proxy',
    PROXY_ADMIN_NAME,
]

/** An "already verified" contract counts only if its published compiler and contract name match ours. */
async function checkPublishedSource(apiURL: string, apiKey: string, form: { [key: string]: string }) {
    const url = new URL(apiURL)
    url.searchParams.set('apikey', apiKey)
    url.searchParams.set('module', 'contract')
    url.searchParams.set('action', 'getsourcecode')
    url.searchParams.set('address', form.contractaddress)
    const published = (await (await fetch(url)).json()).result?.[0]
    const contractName = form.contractname.split(':')[1]
    if (published?.CompilerVersion !== form.compilerversion || published?.ContractName !== contractName) {
        throw new Error(
            `already verified with different source: ${published?.ContractName} ${published?.CompilerVersion}`
        )
    }
}

/** Submit one standard-JSON verification to an Etherscan V2 endpoint and wait for the result. */
export async function etherscanVerify(apiURL: string, apiKey: string, form: { [key: string]: string }) {
    const body = new URLSearchParams({ apikey: apiKey, module: 'contract', action: 'verifysourcecode', ...form })
    const submitted = await (await fetch(apiURL, { method: 'POST', body })).json()
    if (String(submitted.result).toLowerCase().includes('already verified')) {
        return checkPublishedSource(apiURL, apiKey, form)
    }
    if (submitted.status !== '1') {
        throw new Error(`submit failed: ${submitted.message} ${submitted.result}`)
    }

    const statusUrl = new URL(apiURL)
    statusUrl.searchParams.set('apikey', apiKey)
    statusUrl.searchParams.set('module', 'contract')
    statusUrl.searchParams.set('action', 'checkverifystatus')
    statusUrl.searchParams.set('guid', submitted.result)
    const deadline = Date.now() + 10 * 60 * 1000
    for (;;) {
        if (Date.now() > deadline) throw new Error('verification still pending after 10 minutes')
        const status = await (await fetch(statusUrl)).json()
        if (String(status.result).toLowerCase().includes('already verified')) {
            return checkPublishedSource(apiURL, apiKey, form)
        }
        if (status.result !== 'Pending in queue') {
            if (status.status === '1') return
            throw new Error(`verification failed: ${status.result}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 5000))
    }
}

/** Verify all wTARI contracts; throws listing every contract that is not verified. */
export async function verifyWtariContracts(hre: HardhatRuntimeEnvironment, config: WtariChainConfig) {
    if (!config.explorer) throw new Error('No explorer configured for this chain')
    const apiKey = process.env.ETHERSCAN_API_KEY
    if (!apiKey) throw new Error('ETHERSCAN_API_KEY is not set')

    const unverified: string[] = []
    for (const name of VERIFY_NAMES) {
        const deployment = await hre.deployments.get(name)
        try {
            const metadata = JSON.parse(deployment.metadata as string)
            const [sourceName, contractName] = Object.entries(metadata.settings.compilationTarget)[0] as [
                string,
                string,
            ]
            const solcInputFile = path.join(
                hre.config.paths.deployments,
                hre.network.name,
                'solcInputs',
                `${deployment.solcInputHash}.json`
            )
            const constructor = deployment.abi.find((item) => item.type === 'constructor')
            const constructorArgs = constructor
                ? ethers.utils.defaultAbiCoder.encode(constructor.inputs, deployment.args ?? []).slice(2)
                : ''

            await etherscanVerify(config.explorer.apiURL, apiKey, {
                contractaddress: deployment.address,
                sourceCode: fs.readFileSync(solcInputFile, 'utf8'),
                codeformat: 'solidity-standard-json-input',
                contractname: `${sourceName}:${contractName}`,
                compilerversion: `v${metadata.compiler.version}`,
                constructorArguements: constructorArgs,
            })
            console.log(`verified ${name} ${config.explorer.browserURL}/address/${deployment.address}`)
        } catch (e) {
            unverified.push(`${name} ${deployment.address}: ${(e as Error).message}`)
        }
    }

    if (unverified.length > 0) {
        throw new Error(
            `Deployment is complete but these contracts are not verified (re-run verify:wtari):\n${unverified.join('\n')}`
        )
    }
}

export type ExportedEntry = { [key: string]: string | number }

/**
 * One chain's entry for the package's deployments.json. The wTARI* records are exported only as the exact
 * WTARI_RECORD_NAMES set: unchanged addresses keep what was exported (and checked) before; new or changed
 * addresses are exported only if `check` (check:wtari, returning the bridge start block) passes. When the set
 * is incomplete, has unexpected wTARI* records, or fails the check, the last good (previously exported) set
 * is kept. Other records are always exported.
 */
export async function exportedChainEntry(
    previous: ExportedEntry,
    addresses: { [name: string]: string },
    check: () => Promise<number>
) {
    const entry: ExportedEntry = {}
    for (const [key, value] of Object.entries(previous)) {
        if (!key.startsWith('wTARI')) entry[key] = value
    }
    const wtariAddresses: ExportedEntry = {}
    for (const [name, address] of Object.entries(addresses)) {
        if (name.startsWith('wTARI')) wtariAddresses[name] = address
        else entry[name] = address
    }

    const previousWtari = Object.entries(previous).filter(([key]) => key.startsWith('wTARI'))
    const previousAddresses = previousWtari.filter(([key]) => key !== 'wTARIBridgeStartBlock')
    const keepLastGood = (message: string) => {
        console.warn(`WARNING: ${message}; the new wTARI entries are not exported.`)
        for (const [key, value] of previousWtari) entry[key] = value
        return { entry, wtariFailed: true }
    }

    const names = Object.keys(wtariAddresses)
    const unchanged =
        previous.wTARIBridgeStartBlock !== undefined &&
        previousAddresses.length === names.length &&
        previousAddresses.every(([key, value]) => wtariAddresses[key] === value)

    // check:wtari is a deploy-time review, so later Safe operations (role rotation, peers, retirement) must
    // not block exports of an unchanged set.
    if (names.length === 0 || unchanged) {
        for (const [key, value] of previousWtari) entry[key] = value
        return { entry, wtariFailed: false }
    }
    if (names.length !== WTARI_RECORD_NAMES.length || !WTARI_RECORD_NAMES.every((name) => name in wtariAddresses)) {
        return keepLastGood(`wTARI records ${names.join(', ')} are not exactly ${WTARI_RECORD_NAMES.join(', ')}`)
    }
    try {
        const bridgeStartBlock = await check()
        Object.assign(entry, wtariAddresses, { wTARIBridgeStartBlock: bridgeStartBlock })
        return { entry, wtariFailed: false }
    } catch (e) {
        return keepLastGood(`check:wtari failed\n${(e as Error).message}`)
    }
}

/**
 * Offline check of the package's deployments.json (no RPC): every chain with a wTARI* key must have a
 * deploy/wtari/<chainId>.json, exactly the WTARI_RECORD_NAMES keys at their recomputed CREATE2 addresses, and
 * a positive integer wTARIBridgeStartBlock. Returns the problems found.
 */
export async function wtariPackageProblems(
    hre: HardhatRuntimeEnvironment,
    exported: { [chainId: string]: ExportedEntry }
) {
    const problems: string[] = []
    for (const [chainId, entry] of Object.entries(exported)) {
        const keys = Object.keys(entry).filter((key) => key.startsWith('wTARI'))
        if (keys.length === 0) continue
        if (!fs.existsSync(path.join(CONFIG_DIR, `${chainId}.json`))) {
            problems.push(`chain ${chainId}: has wTARI entries but no deploy/wtari/${chainId}.json`)
            continue
        }
        const config = readWtariConfig(Number(chainId))
        const expected = await expectedWtariCreations(
            hre,
            config,
            officialLzEndpoint(config.network.eid, Number(chainId))
        )
        const wanted = [...WTARI_RECORD_NAMES, 'wTARIBridgeStartBlock']
        for (const key of keys) {
            if (!wanted.includes(key)) problems.push(`chain ${chainId}: unexpected key ${key}`)
        }
        for (const name of WTARI_RECORD_NAMES) {
            const value = entry[name]
            if (value === undefined) problems.push(`chain ${chainId}: missing ${name}`)
            else if (String(value).toLowerCase() !== expected[name].address.toLowerCase()) {
                problems.push(
                    `chain ${chainId}: ${name} ${value} is not the expected CREATE2 address ${expected[name].address}`
                )
            }
        }
        const startBlock = entry.wTARIBridgeStartBlock
        if (!Number.isInteger(startBlock) || (startBlock as number) <= 0) {
            problems.push(`chain ${chainId}: wTARIBridgeStartBlock ${startBlock} is not a positive integer`)
        }
    }
    return problems
}

async function assertChain(hre: HardhatRuntimeEnvironment, chain: number) {
    const chainId = Number(await hre.getChainId())
    if (chainId !== chain) {
        throw new Error(`--chain ${chain} does not match network ${hre.network.name} (chain ${chainId})`)
    }
}

/** Production chains must not fall back to a public default RPC. */
function assertProductionRpc(config: WtariChainConfig) {
    if (config.production && !process.env[config.network.rpcUrlEnv]) {
        throw new Error(`${config.network.rpcUrlEnv} must be set for a production chain`)
    }
}

export function referenceProviderFor(config: WtariChainConfig) {
    const rpcUrl = process.env[config.referenceRpcUrlEnv]
    if (!rpcUrl) throw new Error(`${config.referenceRpcUrlEnv} is not set`)
    return new providers.JsonRpcProvider(rpcUrl)
}

/** Runs `action`, replacing any RPC URL (which may embed an API key) in its error with the env var name. */
export async function withRedactedRpcUrls(config: WtariChainConfig, action: () => Promise<void>) {
    try {
        await action()
    } catch (e) {
        let message = e instanceof Error ? e.message : String(e)
        for (const name of [config.network.rpcUrlEnv, config.referenceRpcUrlEnv]) {
            const url = process.env[name]
            if (url) message = message.split(url).join(`<${name}>`)
        }
        throw new Error(message)
    }
}

task('deploy:wtari', 'Deploy wTARI, wTARIController and wTARIBridge using deploy/wtari/<chain>.json')
    .addParam('chain', 'Target chain id (must match --network)', undefined, types.int)
    .addOptionalParam('safeNonce', 'proxyAdminOwner Safe nonce, to print the pending safeTxHash', undefined, types.int)
    .setAction(async ({ chain, safeNonce }: { chain: number; safeNonce?: number }, hre) => {
        const config = readWtariConfig(chain)
        await withRedactedRpcUrls(config, async () => {
            await assertChain(hre, chain)
            if (config.production && !(hre.network.config as { kmsKeyId?: string }).kmsKeyId) {
                throw new Error('A production chain must be deployed with the KMS signer: set KMS_KEY_ID')
            }
            const referenceProvider = referenceProviderFor(config)

            const lzEndpoint = officialLzEndpoint(config.network.eid, chain)
            const pending = await deployWtari(hre, config, lzEndpoint, referenceProvider)
            // The full check runs before the Safe is asked to sign anything; only the grant may be missing.
            const { pendingSafeTransaction } = await checkWtariDeployment(hre, config, referenceProvider, {
                preGrant: pending !== undefined,
            })
            // Printed only after the check passed, and before verification (which can fail on its own).
            if (pendingSafeTransaction) {
                printSafeTransaction(config.proxyAdminOwner, pendingSafeTransaction, chain, safeNonce)
                console.log(
                    'Before signing, a Safe signer runs check:wtari --pre-grant on a second machine (with its own RPC)' +
                        ' and compares the queued Safe transaction byte for byte with the one it prints.'
                )
            }
            if (hre.network.name !== 'hardhat') await verifyWtariContracts(hre, config)
        })
    })

task('verify:wtari', 'Verify all wTARI contracts on the chain explorer (Etherscan V2)')
    .addParam('chain', 'Target chain id (must match --network)', undefined, types.int)
    .setAction(async ({ chain }: { chain: number }, hre) => {
        const config = readWtariConfig(chain)
        await withRedactedRpcUrls(config, async () => {
            await assertChain(hre, chain)
            await verifyWtariContracts(hre, config)
        })
    })

task('check:wtari', 'Check wTARI Safes, roles, ownership, LZ config, bytecode and proxies on the --network chain')
    .addParam('chain', 'Target chain id (must match --network)', undefined, types.int)
    .addFlag(
        'preGrant',
        'Allow the pending grantRole(MINTER_ROLE, controller) to be missing (review before signing it)'
    )
    .addOptionalParam('safeNonce', 'proxyAdminOwner Safe nonce, to print the pending safeTxHash', undefined, types.int)
    .setAction(
        async ({ chain, preGrant, safeNonce }: { chain: number; preGrant: boolean; safeNonce?: number }, hre) => {
            const config = readWtariConfig(chain)
            await withRedactedRpcUrls(config, async () => {
                await assertChain(hre, chain)
                const { pendingSafeTransaction } = await checkWtariDeployment(
                    hre,
                    config,
                    referenceProviderFor(config),
                    {
                        preGrant,
                    }
                )
                if (pendingSafeTransaction) {
                    printSafeTransaction(config.proxyAdminOwner, pendingSafeTransaction, chain, safeNonce)
                }
            })
        }
    )

task('verify:wtari-package', 'Offline check of the wTARI entries in the package deployments.json (no RPC)').setAction(
    async (_args, hre) => {
        const file = path.join(__dirname, '..', 'wxtm-bridge-contracts-typechain', 'deployments', 'deployments.json')
        const problems = await wtariPackageProblems(hre, JSON.parse(fs.readFileSync(file, 'utf8')))
        if (problems.length > 0) throw new Error(`wTARI package entries are invalid:\n${problems.join('\n')}`)
        console.log('wTARI package entries match the recomputed CREATE2 addresses')
    }
)
