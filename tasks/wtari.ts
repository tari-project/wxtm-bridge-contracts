import fs from 'fs'
import path from 'path'

import { Contract, ethers, providers } from 'ethers'
import { task, types } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import ProxyAdmin from 'hardhat-deploy/extendedArtifacts/ProxyAdmin.json'

import { EndpointId, endpointIdToNetwork } from '@layerzerolabs/lz-definitions'
import { getDeploymentAddressAndAbi } from '@layerzerolabs/lz-evm-sdk-v2'

import verify from '../utils/verify'

export interface WtariChainConfig {
    mintLowSafe: string
    mintHighSafe: string
    proxyAdminOwner: string
    confirmations: number
    referenceChainId: number
    referenceRpcUrlEnv: string
    referenceMintLowSafe: string
    referenceMintHighSafe: string
}

const SAFE_ABI = ['function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)']
const PROXY_ADMIN_NAME = 'wTARIProxyAdmin'
const DEFAULT_ADMIN_ROLE = ethers.constants.HashZero
const MINTER_ROLE = ethers.utils.id('MINTER_ROLE')
const LOW_MINTER_ROLE = ethers.utils.id('LOW_MINTER_ROLE')
const HIGH_MINTER_ROLE = ethers.utils.id('HIGH_MINTER_ROLE')
// EIP-1967 storage slots
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

export function readWtariConfig(chainId: number): WtariChainConfig {
    const file = path.join(__dirname, '..', 'deploy', 'wtari', `${chainId}.json`)
    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

async function checkHasCode(provider: providers.Provider, label: string, address: string) {
    if ((await provider.getCode(address)) === '0x') {
        throw new Error(`${label} ${address} has no code on the target chain`)
    }
}

async function checkSafeMatchesReference(
    provider: providers.Provider,
    referenceProvider: providers.Provider,
    label: string,
    safe: string,
    referenceSafe: string
) {
    await checkHasCode(provider, label, safe)

    const target = new Contract(safe, SAFE_ABI, provider)
    const reference = new Contract(referenceSafe, SAFE_ABI, referenceProvider)

    const owners = (await target.getOwners()).map((a: string) => a.toLowerCase()).sort()
    const referenceOwners = (await reference.getOwners()).map((a: string) => a.toLowerCase()).sort()
    if (owners.join(',') !== referenceOwners.join(',')) {
        throw new Error(`${label} ${safe} owners differ from reference Safe ${referenceSafe}`)
    }

    const threshold = await target.getThreshold()
    const referenceThreshold = await reference.getThreshold()
    if (!threshold.eq(referenceThreshold)) {
        throw new Error(
            `${label} ${safe} threshold ${threshold} differs from reference Safe threshold ${referenceThreshold}`
        )
    }
}

export async function deployWtari(
    hre: HardhatRuntimeEnvironment,
    config: WtariChainConfig,
    lzEndpoint: string,
    referenceProvider: providers.Provider
) {
    const { deploy, execute, read } = hre.deployments
    const provider = hre.ethers.provider

    if ((await referenceProvider.getNetwork()).chainId !== config.referenceChainId) {
        throw new Error(`Reference provider is not on chain ${config.referenceChainId}`)
    }
    await checkSafeMatchesReference(
        provider,
        referenceProvider,
        'mintLowSafe',
        config.mintLowSafe,
        config.referenceMintLowSafe
    )
    await checkSafeMatchesReference(
        provider,
        referenceProvider,
        'mintHighSafe',
        config.mintHighSafe,
        config.referenceMintHighSafe
    )
    await checkHasCode(provider, 'proxyAdminOwner', config.proxyAdminOwner)
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
        deterministicDeployment: ethers.utils.id('wTARI-v0.0.1'),
        log: true,
        waitConfirmations: config.confirmations,
        proxy: {
            ...proxy,
            viaAdminContract: { name: PROXY_ADMIN_NAME, artifact: ProxyAdmin },
            execute: { init: { methodName: 'initialize', args: ['WrappedTARI', 'wTARI', '1', deployer] } },
        },
    })

    const controller = await deploy('wTARIController', {
        from: deployer,
        args: [],
        deterministicDeployment: ethers.utils.id('wTARIController-v0.0.1'),
        log: true,
        waitConfirmations: config.confirmations,
        proxy: {
            ...proxy,
            execute: {
                init: {
                    methodName: 'initialize',
                    args: [token.address, config.mintLowSafe, config.mintHighSafe, config.proxyAdminOwner],
                },
            },
        },
    })

    const bridge = await deploy('wTARIBridge', {
        from: deployer,
        args: [],
        deterministicDeployment: ethers.utils.id('wTARIBridge-v0.0.1'),
        log: true,
        waitConfirmations: config.confirmations,
        proxy: {
            ...proxy,
            execute: { init: { methodName: 'initialize', args: [token.address] } },
        },
    })

    // The deployer only holds token admin until this setup is done; skip it on re-runs.
    if (await read('wTARI', 'hasRole', DEFAULT_ADMIN_ROLE, deployer)) {
        const opts = { from: deployer, log: true, waitConfirmations: config.confirmations }
        await execute('wTARI', opts, 'grantRole', MINTER_ROLE, controller.address)
        await execute('wTARI', opts, 'grantRole', DEFAULT_ADMIN_ROLE, config.proxyAdminOwner)
        await execute('wTARI', opts, 'setDelegate', config.proxyAdminOwner)
        await execute('wTARI', opts, 'transferOwnership', config.proxyAdminOwner)
        await execute('wTARI', opts, 'renounceRole', DEFAULT_ADMIN_ROLE, deployer)
    }

    console.log(`wTARI: ${token.address} (implementation ${token.implementation})`)
    console.log(`wTARIController: ${controller.address} (implementation ${controller.implementation})`)
    console.log(`wTARIBridge: ${bridge.address} (implementation ${bridge.implementation})`)

    if (hre.network.name !== 'hardhat') {
        await verify(hre, token.implementation as string, [lzEndpoint])
        await verify(hre, controller.implementation as string, [])
        await verify(hre, bridge.implementation as string, [])
    }
}

/** Post-deploy review: role grants, code at every role holder, and proxy admin/implementation slots. */
export async function checkWtariDeployment(hre: HardhatRuntimeEnvironment, config: WtariChainConfig) {
    const { get, read } = hre.deployments
    const { deployer } = await hre.getNamedAccounts()
    const provider = hre.ethers.provider
    const failures: string[] = []

    const token = await get('wTARI')
    const controller = await get('wTARIController')
    const bridge = await get('wTARIBridge')
    const proxyAdmin = await get(PROXY_ADMIN_NAME)

    const expectedRoles: [string, string, string, string][] = [
        ['wTARI', 'MINTER_ROLE', MINTER_ROLE, controller.address],
        ['wTARI', 'DEFAULT_ADMIN_ROLE', DEFAULT_ADMIN_ROLE, config.proxyAdminOwner],
        ['wTARIController', 'LOW_MINTER_ROLE', LOW_MINTER_ROLE, config.mintLowSafe],
        ['wTARIController', 'HIGH_MINTER_ROLE', HIGH_MINTER_ROLE, config.mintHighSafe],
        ['wTARIController', 'DEFAULT_ADMIN_ROLE', DEFAULT_ADMIN_ROLE, config.proxyAdminOwner],
    ]
    for (const [name, roleName, role, account] of expectedRoles) {
        if (!(await read(name, 'hasRole', role, account))) {
            failures.push(`${name}: ${account} is missing ${roleName}`)
        }
        if ((await provider.getCode(account)) === '0x') {
            failures.push(`${name}: ${roleName} holder ${account} has no code`)
        }
    }

    for (const name of ['wTARI', 'wTARIController']) {
        for (const [roleName, role] of [
            ['DEFAULT_ADMIN_ROLE', DEFAULT_ADMIN_ROLE],
            ['MINTER_ROLE', MINTER_ROLE],
            ['LOW_MINTER_ROLE', LOW_MINTER_ROLE],
            ['HIGH_MINTER_ROLE', HIGH_MINTER_ROLE],
        ]) {
            if (await read(name, 'hasRole', role, deployer)) {
                failures.push(`${name}: deployer ${deployer} still holds ${roleName}`)
            }
        }
    }

    if ((await read('wTARI', 'owner')).toLowerCase() !== config.proxyAdminOwner.toLowerCase()) {
        failures.push(`wTARI: owner is not proxyAdminOwner ${config.proxyAdminOwner}`)
    }
    if ((await read(PROXY_ADMIN_NAME, 'owner')).toLowerCase() !== config.proxyAdminOwner.toLowerCase()) {
        failures.push(`${PROXY_ADMIN_NAME}: owner is not proxyAdminOwner ${config.proxyAdminOwner}`)
    }

    for (const deployment of [token, controller, bridge]) {
        const admin = ethers.utils.hexDataSlice(await provider.getStorageAt(deployment.address, ADMIN_SLOT), 12)
        const implementation = ethers.utils.hexDataSlice(
            await provider.getStorageAt(deployment.address, IMPLEMENTATION_SLOT),
            12
        )
        console.log(`proxy ${deployment.address}: admin ${admin}, implementation ${implementation}`)
        if (admin.toLowerCase() !== proxyAdmin.address.toLowerCase()) {
            failures.push(
                `proxy ${deployment.address}: admin ${admin} is not ${PROXY_ADMIN_NAME} ${proxyAdmin.address}`
            )
        }
        if (implementation.toLowerCase() !== deployment.implementation?.toLowerCase()) {
            failures.push(`proxy ${deployment.address}: implementation ${implementation} differs from the record`)
        }
    }

    if (failures.length > 0) {
        throw new Error(`wTARI deployment check failed:\n${failures.join('\n')}`)
    }
    console.log('wTARI deployment check passed')
}

async function assertChain(hre: HardhatRuntimeEnvironment, chain: number) {
    const chainId = Number(await hre.getChainId())
    if (chainId !== chain) {
        throw new Error(`--chain ${chain} does not match network ${hre.network.name} (chain ${chainId})`)
    }
}

task('deploy:wtari', 'Deploy wTARI, wTARIController and wTARIBridge using deploy/wtari/<chain>.json')
    .addParam('chain', 'Target chain id (must match --network)', undefined, types.int)
    .setAction(async ({ chain }: { chain: number }, hre) => {
        await assertChain(hre, chain)
        const config = readWtariConfig(chain)

        const rpcUrl = process.env[config.referenceRpcUrlEnv]
        if (!rpcUrl) throw new Error(`${config.referenceRpcUrlEnv} is not set`)

        const eid = hre.network.config.eid as EndpointId
        const { address: lzEndpoint } = getDeploymentAddressAndAbi(endpointIdToNetwork(eid), 'EndpointV2')

        await deployWtari(hre, config, lzEndpoint, new providers.JsonRpcProvider(rpcUrl))
        await checkWtariDeployment(hre, config)
    })

task('check:wtari', 'Check wTARI role grants and proxy admin on the --network chain')
    .addParam('chain', 'Target chain id (must match --network)', undefined, types.int)
    .setAction(async ({ chain }: { chain: number }, hre) => {
        await assertChain(hre, chain)
        await checkWtariDeployment(hre, readWtariConfig(chain))
    })
