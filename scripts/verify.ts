import verify from '../utils/verify'

const main = async () => {
    const contractAddress = '0x5496938B0206EF6F492bc216bb6e73558D66861E'
    // LayerZero Sepolia Address: 0x6EDCE65403992e310A62460808c4b910D972f10f
    const constructorArgs = ['0x6EDCE65403992e310A62460808c4b910D972f10f']

    await verify(contractAddress, constructorArgs)
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
