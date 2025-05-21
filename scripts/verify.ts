import { run, network } from 'hardhat'
import verify from '../utils/verify'

const main = async () => {
    const contractAddress = '0xeadc0c18Dc0aA45146068290B93F57E033Db91E5'

    /** @dev wXTM args */
    // LayerZero Sepolia Address: 0x6EDCE65403992e310A62460808c4b910D972f10f
    //const constructorArgs = ['0x6EDCE65403992e310A62460808c4b910D972f10f']

    /** @dev wXTMBridge args */
    const constructorArgs = []

    await verify({ run, network } as any, contractAddress, constructorArgs)
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
