import { KMSClient } from '@aws-sdk/client-kms'
import { createSignature, getEthAddressFromKMS } from '@rumblefishdev/eth-signer-kms'
import { ethers } from 'hardhat'
import 'dotenv/config'

async function signMessage() {
    if (!process.env.KMS_KEY_ID) {
        throw new Error('KMS_KEY_ID environment variable is not set.')
    }

    const kmsKeyId = process.env.KMS_KEY_ID
    const kmsInstance = new KMSClient()

    const address = await getEthAddressFromKMS({
        keyId: kmsKeyId,
        kmsInstance: kmsInstance,
    })

    console.log('Signing with address:', address)

    const etherscanUsername = 'fp1tari'
    const contractAddress = '0x810be828EFA687667B289C488A57a7B48Fb4523E'
    const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

    const message = `I, ${etherscanUsername}, on ${date} hereby request Exact Match Reverifcation for ${contractAddress}.`
    console.log('Signing message:\n', message)

    const messageHash = ethers.utils.hashMessage(message)

    const sig = await createSignature({
        kmsInstance: kmsInstance,
        keyId: kmsKeyId,
        message: messageHash,
        address: address,
    })

    const signature = ethers.utils.joinSignature(sig)

    console.log('\nSignature:\n', signature)
    console.log('\nMessage Signature Hash:\n', messageHash)

    // Optional: Verify the signature to ensure correctness
    const recoveredAddress = ethers.utils.verifyMessage(message, sig)
    if (recoveredAddress.toLowerCase() === address.toLowerCase()) {
        console.log('\nSignature confirmed to be valid.')
    } else {
        console.error('\nWarning: Signature verification failed.')
    }
}

signMessage().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
