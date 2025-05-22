import { ethers } from 'hardhat'

async function transferETH() {
    const recipient = '0x07d5D1c02c858e05E66fccC0f5856dddF14c4205'
    const amountETH = '0.03'

    const [deployer] = await ethers.getSigners()
    const senderAddress = await deployer.getAddress()

    const network = await ethers.provider.getNetwork()
    console.log(`Network Name: ${network.name}`)
    console.log(`Sending ${amountETH} ETH from ${senderAddress} to ${recipient}`)

    const tx = await deployer.sendTransaction({
        to: recipient,
        value: ethers.utils.parseEther(amountETH),
    })

    console.log('Transaction hash: ', tx.hash)

    await tx.wait()
    console.log('Transaction processed successfully!')
}

transferETH().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
