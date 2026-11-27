import fs from 'fs'
import path from 'path'

import { ContractFactory, Signer, ethers } from 'ethers'

/** Deploys test/mocks/SafeMock (a test-only contract, so compiled by forge into out/, not by hardhat). */
export async function deploySafeMock(signer: Signer, owners: string[], threshold = 1) {
    const artifact = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '..', 'out/SafeMock.sol/SafeMock.json'), 'utf8')
    )
    const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, signer)
    return (await factory.deploy(ethers.constants.AddressZero, owners, threshold)).address
}
