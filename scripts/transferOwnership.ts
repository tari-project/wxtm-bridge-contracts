import { ethers } from 'hardhat'

async function transferOwnership() {
    const contractAddress = ''
    const newOwner = ''

    const contract = await ethers.getContractAt('wXTM', contractAddress)

    const tx = await contract.transferOwnership(newOwner)
    console.log('Transaction hash: ', tx.hash)

    await tx.wait()
    console.log(`Transaction processed successfully!`)
}

transferOwnership().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
