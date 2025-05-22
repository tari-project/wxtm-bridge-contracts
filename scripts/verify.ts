import { run, network } from 'hardhat'
import verify from '../utils/verify'

const main = async () => {
    const contractAddress = '0x0866D13B8bb13fe94bde3A6373287dBC7e7D4760'

    /** @dev wXTM args */
    // LayerZero Sepolia Address: 0x6EDCE65403992e310A62460808c4b910D972f10f
    //const constructorArgs = ['0x6EDCE65403992e310A62460808c4b910D972f10f']

    /** @dev wXTMBridge args */
    const constructorArgs: any[] = ['0x1a44076050125825900e736c501f859c50fE728c']

    await verify({ run, network } as any, contractAddress, constructorArgs)
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
