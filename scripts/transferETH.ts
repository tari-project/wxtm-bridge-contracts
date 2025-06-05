import { ethers } from 'hardhat'

transferETH().catch((error) => {
    console.error(error)
    process.exitCode = 1
})

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

async function transferFullEthBalance() {
    const recipient = '0xaBEc0A839deb18312D805Fd25dfA13aE7f1eEdA3'

    const [deployer] = await ethers.getSigners()
    const senderAddress = await deployer.getAddress()

    const network = await ethers.provider.getNetwork()
    console.log(`Network Name: ${network.name}`)

    const balance = await ethers.provider.getBalance(senderAddress)
    const gasPrice = await ethers.provider.getGasPrice()
    const gasLimit = ethers.BigNumber.from(21000)

    const gasCost = gasPrice.mul(gasLimit)

    const gasBuffer = gasCost.div(20) // 5% buffer
    const totalGasCost = gasCost.add(gasBuffer)
    console.log('Total gasCost: ', totalGasCost)

    const amountToSend = balance.sub(totalGasCost)
    console.log(`Sending ${amountToSend} ETH from ${senderAddress} to ${recipient}`)

    const tx = await deployer.sendTransaction({
        to: recipient,
        value: amountToSend,
    })

    console.log('Transaction hash: ', tx.hash)

    await tx.wait()
    console.log('Transaction processed successfully!')
}
