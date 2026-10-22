# wTARI internal review checklist (per chain)

Copy this file to `deployments/<network>/wtari-review-checklist.md` after `deploy:wtari` and fill it in. One copy per chain.

| Field                          | Value |
| ------------------------------ | ----- |
| Chain id / network             |       |
| Package version                |       |
| wTARI (proxy / impl)           |       |
| wTARIController (proxy / impl) |       |
| wTARIBridge (proxy / impl)     |       |
| wTARIBridgeStartBlock          |       |
| wTARIProxyAdmin                |       |
| mint-low Safe                  |       |
| mint-high Safe                 |       |
| proxy-admin Safe               |       |
| Reviewer / date                |       |

## Checks

- [ ] Each cloned `.sol` differs from its wXTM source by names only (`npm run test:hardhat`, "wTARI clones").
- [ ] Initializers cannot be re-run (`wTARITest.test_initializers_cannot_be_rerun`, hardhat "initializers cannot be re-run").
- [ ] Proxy admin and implementation addresses recorded above (printed by `check:wtari`).
- [ ] `npm run check:wtari -- --network <network> --chain <chainId>` passes: `hasRole` grants match this chain's Safes, every role holder has code on this chain, the deployer holds no role, and `wTARI.owner()` and `wTARIProxyAdmin.owner()` are the proxy-admin Safe.
- [ ] `mintLowAmount` / `mintHighAmount` are callable only by the respective Safe (`wTARITest.test_mint_*_only_by_*_safe`; on testnets also one real mint-low Safe transaction).
- [ ] Pause: the wXTM sources have no pause, so the clones have none. To retire a chain, the proxy-admin Safe revokes `LOW_MINTER_ROLE` / `HIGH_MINTER_ROLE` on wTARIController and/or `MINTER_ROLE` (the controller) on wTARI.
- [ ] Mint then burn emits `TokensUnwrapped` with nonce 0 and an `otl_esm_…` address (`wTARITest.test_mint_then_bridge_*`; on testnets also one real `bridgeToTariWithAuthorization`).
- [ ] All implementations verified on the chain explorer and token metadata submitted.

Signed off by (name, date):
