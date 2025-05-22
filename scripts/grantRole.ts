import { ethers } from 'hardhat'

async function grantRole() {
    const contractAddress = '0xfD36fA88bb3feA8D1264fc89d70723b6a2B56958'
    const controller = '0x6c6f5B091bc50a6cB62e55B5c1EB7455205d2880'

    const lowMinter = '0x7cC835597EADFa3C5A5d9f0B90c0491C289B8Eee'
    const highMinter = '0xFa2459708A9549C371963a3fCd239dd614E8D52C'

    const MINTER_ROLE = ethers.utils.id('MINTER_ROLE')
    console.log(MINTER_ROLE)

    const contract = await ethers.getContractAt('wXTM', contractAddress)

    const tx = await contract.grantRole(MINTER_ROLE, controller)
    console.log('Transaction hash: ', tx.hash)

    await tx.wait()
    console.log(`Transaction processed successfully!`)
}

grantRole().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
