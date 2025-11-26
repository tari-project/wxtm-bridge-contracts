import { ethers } from 'hardhat'

async function grantRole() {
    /*
    const [deployer] = await ethers.getSigners()
    const senderAddress = await deployer.getAddress()
    console.log(senderAddress)
    // 0x554498c7f1751942D7714aee6Fec976bf4BB72bB
    */

    const controller = '0x31999d652476b9e2ef4DEbA560CD39b9Af1AccA5'
    const lowMinter = '0x4b731EF14788f7371fAC837860Ed7bF2030344d2'

    const HIGH_MINTER_ROLE = ethers.utils.id('HIGH_MINTER_ROLE')
    console.log(HIGH_MINTER_ROLE)

    const contract = await ethers.getContractAt('wXTMController', controller)
    console.log('Contract', contract.address)

    const tx = await contract.grantRole(HIGH_MINTER_ROLE, lowMinter)
    console.log('Transaction hash: ', tx.hash)

    await tx.wait()
    console.log(`Transaction processed successfully!`)
}

grantRole().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
