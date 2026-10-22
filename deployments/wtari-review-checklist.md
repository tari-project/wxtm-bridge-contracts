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

## Trust root

The proxy-admin Safe is the **sole trust root** for this chain: it owns `wTARIProxyAdmin` (can upgrade all three proxies), holds `DEFAULT_ADMIN_ROLE` on wTARI and wTARIController (can grant any role, set the low-tier daily budget), is the wTARI OApp owner, and is its LayerZero delegate. It must be a high-threshold Safe (`check:wtari` requires a threshold of at least 2 and a Safe different from both mint Safes).

The deployer never holds any power: wTARI is initialized with the proxy-admin Safe as owner, LayerZero delegate and `DEFAULT_ADMIN_ROLE` from its first block, and the controller is initialized with the Safes directly.

## Post-deploy Safe transaction

Because only the proxy-admin Safe is wTARI admin, `deploy:wtari` cannot grant the controller `MINTER_ROLE`. It prints the pending transaction (to = wTARI proxy, value 0, data = `grantRole(MINTER_ROLE, wTARIController)`) and finishes. Execute it from the proxy-admin Safe, then run `check:wtari`, which fails until the grant exists.

- [ ] Pending `grantRole(MINTER_ROLE, wTARIController)` Safe transaction executed (Safe tx hash: )

## Checks

- [ ] Clones differ from their wXTM sources by names, the `wTARI` symbol, and only these intentional changes (`npm run test:hardhat`, "wTARI clones", which lists them exactly):
  - wTARIController: a budget for `mintLowAmount` per fixed 24h window (`block.timestamp / 1 days`), not a rolling one, so up to 2x the limit can be minted across a window boundary (`lowMintDailyLimit`, set at initialize from `lowMintDailyLimit` in `deploy/wtari/<chainId>.json` in whole tokens, changeable by `DEFAULT_ADMIN_ROLE` via `setLowMintDailyLimit`, event `LowMintDailyLimitSet`, error `LowMintDailyLimitExceeded`).
  - wTARIBridge: `targetTariAddress` must be 1..128 bytes (error `InvalidTargetTariAddress`).
  - Shared `extensions/EIP3009.sol`: authorizations expire at `validBefore` (`block.timestamp >= validBefore` reverts). Deployed wXTM bytecode is unaffected.
- [ ] Initializers cannot be re-run (`wTARITest.test_initializers_cannot_be_rerun`, hardhat "initializers cannot be re-run").
- [ ] Proxy admin and implementation addresses recorded above (printed by `check:wtari`).
- [ ] `npm run check:wtari -- --chain <chainId>` passes. It checks:
  - mint-low, mint-high and proxy-admin Safes: official SafeProxy runtime code (v1.3.0 / v1.4.1 / v1.5.0 code hashes), an official Safe singleton for this chain (from `@safe-global/safe-deployments`), no modules, no transaction or module guard; mint Safes have the owners and threshold of the reference Ethereum Safes (hard-coded in `tasks/wtari.ts` per `referenceChainId`) and are two different Safes; the proxy-admin Safe has threshold >= 2 and is neither mint Safe;
  - `hasRole` grants match this chain's Safes and every role holder has code on this chain;
  - the exact set of `DEFAULT_ADMIN` / `MINTER` / `LOW_MINTER` / `HIGH_MINTER` holders on wTARI and wTARIController, rebuilt from `RoleGranted` / `RoleRevoked` logs since deployment, equals the expected set;
  - neither the deployer (the `from` of the creation transaction, read from the chain) nor the current signer holds any role or ownership, and no `RoleGranted` to the deployer was ever emitted;
  - `wTARI.owner()`, `wTARIProxyAdmin.owner()` and the LayerZero `delegates(wTARI)` are the proxy-admin Safe;
  - `msgInspector()` and `preCrime()` are unset, and no `PeerSet` or `EnforcedOptionSet` event was ever emitted (logs from the creation block, read from the chain);
  - every implementation, proxy and `wTARIProxyAdmin` has the compiled runtime bytecode (immutables masked);
  - `lowMintDailyLimit` equals the config's `lowMintDailyLimit`;
  - every proxy's EIP-1967 admin is `wTARIProxyAdmin` and its implementation matches the record.
- [ ] `mintLowAmount` / `mintHighAmount` are callable only by the respective Safe (`wTARITest.test_mint_*_only_by_*_safe`; on testnets also one real mint-low Safe transaction). The low-tier daily budget printed by `check:wtari` is the intended value.
- [ ] Pause: the wXTM sources have no pause, so the clones have none. To retire a chain, the proxy-admin Safe revokes `LOW_MINTER_ROLE` / `HIGH_MINTER_ROLE` on wTARIController and/or `MINTER_ROLE` (the controller) on wTARI, or sets `lowMintDailyLimit` to 0.
- [ ] Mint then burn emits `TokensUnwrapped` with nonce 0 and an `otl_esm_…` address (`wTARITest.test_mint_then_bridge_*`; on testnets also one real `bridgeToTariWithAuthorization`).
- [ ] Consumers key bridge events by (chainId, bridge address, nonce): nonces start at 0 on every chain, and wXTMBridge and wTARIBridge emit the same `TokensUnwrapped` topic.
- [ ] Known: tokens transferred directly to wTARIBridge (not via `bridgeToTari*`) are stuck; the bridge has no access control, so there is no rescue function.
- [ ] Production chains (`"production": true`) were deployed with `KMS_KEY_ID` and an explicit RPC env var.
- [ ] All 7 contracts verified on the explorer (`verify:wtari`: 3 implementations, 3 proxies, `wTARIProxyAdmin`; an "already verified" contract counts only if its published compiler and contract name match) and token metadata submitted.

## Adding a chain

A new chain needs only `deploy/wtari/<chainId>.json`. The chain must also be listed by the pinned `@safe-global/safe-deployments` devDependency; if it is not, `deploy:wtari` and `check:wtari` refuse with `not an official Safe singleton on chain <chainId>`. The fix is bumping that devDependency in `package.json` (and `npm install`), not a code change.

## Recovery: CREATE2 address already taken

All deployment inputs are public, so anyone can deploy the same implementation or proxy to the deterministic address first, and hardhat-deploy then stops with "already deployed". If that happens: confirm on chain that the existing contract's bytecode, EIP-1967 admin/implementation slots, owner and roles are exactly what `deploy:wtari` would have produced; if so, save it as the deployment record and run `check:wtari`. If anything differs, do not use it: change the salt version in `tasks/wtari.ts` (e.g. `wTARI-v0.0.2`) and deploy again.

Signed off by (name, date):
