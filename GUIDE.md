## Commands

`npx hardhat lz:deploy`
`npm run test:forge`

**LzEndpointId:**
SEPOLIA_V2_TESTNET = 40161
BASESEP_V2_TESTNET = 40245

Sepolia: 11155111
Base Sepolia: 84532

Sepolia: 0x439035F98Ea8626165fb2a6BdE789957e24c47dA
Base:

1. `OFTAdapter` -> use if ERC20 already exist on chain. Adapter contract to act as an intermediary lockbox for the token.
2. `OFT.setPeer` -> whitelist each destination contract on every destination chain.

### Todo

#### **wxtm-bridge-contracts**

1. **Create wXTM token based on OTF (LayerZero):**
   We should use AccessControl mixin for mint(). The role for minting will be assigned to gnosis safe (multi-sig-wallet) instance.

2. **Deploy wXTM to sepolia:**
   Deploy contract.

3. **Create Bridge contract:**
   This contract should record incoming transfers (Ethereum -> Tari).
   Ideally the token should have transferWithAuthorization (ERC-3009) extention.
   The method for transfering should use receiveWithAuthorization to pull funds from the sender, emit an event burn tokens.
   // Will this be owner of WXTM?

4. **Demonstrate how LayerZero bridging works (for example from sepolia to base-sepolia):**
   Demo.
