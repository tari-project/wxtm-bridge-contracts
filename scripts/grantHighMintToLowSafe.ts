import { ethers } from 'hardhat'

async function grantRole() {
  /*
    const [deployer] = await ethers.getSigners()
    const senderAddress = await deployer.getAddress()
    console.log(senderAddress)
    // 0xe178b64Acf345A48a5a9FD34CA4F8d9cbA864fCB
  */

    const controller = '0x6c6f5B091bc50a6cB62e55B5c1EB7455205d2880'
    const lowMinter = '0x7cC835597EADFa3C5A5d9f0B90c0491C289B8Eee'
    // 0x5d495dfb0278474619ed1fdc4d8c47ed4348e615b8e6305d0294b6cd00a8bd5f

    const HIGH_MINTER_ROLE = ethers.utils.id('HIGH_MINTER_ROLE')
    console.log(HIGH_MINTER_ROLE)

    const contract = await ethers.getContractAt('wXTMController', controller)

    const tx = await contract.grantRole(HIGH_MINTER_ROLE, lowMinter)
    console.log('Transaction hash: ', tx.hash)

    await tx.wait()
    console.log(`Transaction processed successfully!`)
}

grantRole().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
