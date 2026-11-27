import fs from 'fs'
import path from 'path'

import { ContractFactory, Signer, ethers } from 'ethers'
import hre from 'hardhat'

// Official v1.4.1 Safe singleton on Ethereum (the local hardhat network checks against Ethereum's set).
export const SAFE_SINGLETON = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762'
// Runtime code of an official v1.4.1 SafeProxy (from SafeProxyFactory 0x4e1DCf7A...proxyCreationCode on Ethereum).
export const SAFE_PROXY_V141_RUNTIME =
    '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033'

/** Deploys test/mocks/SafeMock itself (not behind a SafeProxy): Safe-shaped, but not an official Safe. */
export async function deploySafeMock(signer: Signer, owners: string[], threshold = 1) {
    // SafeMock is a test-only contract, so it is compiled by forge into out/, not by hardhat.
    const artifact = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '..', 'out/SafeMock.sol/SafeMock.json'), 'utf8')
    )
    const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, signer)
    return (await factory.deploy(ethers.constants.AddressZero, owners, threshold)).address
}

const toWord = (value: string | number | ethers.BigNumber) =>
    ethers.utils.hexZeroPad(ethers.BigNumber.from(value).toHexString(), 32)
const setStorage = (address: string, slot: string | number | ethers.BigNumber, value: string | number) =>
    hre.network.provider.send('hardhat_setStorageAt', [
        address,
        ethers.BigNumber.from(slot).toHexString(),
        toWord(value),
    ])

/**
 * A real v1.4.1 SafeProxy whose singleton (SafeMock code at the official singleton address) uses SafeMock's storage
 * layout: slot 0 singleton, 1 owners, 2 threshold, 3 modules.
 */
export async function makeSafeProxy(owners: string[], threshold = 1, singleton = SAFE_SINGLETON) {
    if ((await hre.ethers.provider.getCode(SAFE_SINGLETON)) === '0x') {
        const [signer] = await hre.ethers.getSigners()
        const template = await deploySafeMock(signer, [], 0)
        await hre.network.provider.send('hardhat_setCode', [
            SAFE_SINGLETON,
            await hre.ethers.provider.getCode(template),
        ])
    }
    const address = ethers.Wallet.createRandom().address
    await hre.network.provider.send('hardhat_setCode', [address, SAFE_PROXY_V141_RUNTIME])
    await setStorage(address, 0, singleton)
    await setStorage(address, 1, owners.length)
    const ownersStart = ethers.BigNumber.from(ethers.utils.keccak256(toWord(1)))
    for (let i = 0; i < owners.length; i++) await setStorage(address, ownersStart.add(i), owners[i])
    await setStorage(address, 2, threshold)
    return address
}
