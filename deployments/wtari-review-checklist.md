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

Because only the proxy-admin Safe is wTARI admin, `deploy:wtari` cannot grant the controller `MINTER_ROLE`. It first runs the full check in pre-grant mode (only that grant may be missing, and `totalSupply()` must be 0), then prints the pending transaction (to = wTARI proxy, value 0, data = `grantRole(MINTER_ROLE, wTARIController)`) and finishes.

Before any Safe owner signs, a Safe signer runs `npm run check:wtari -- --chain <chainId> --pre-grant`, ideally on a second machine, and it must pass. After the Safe executes the transaction, run `check:wtari` without `--pre-grant`; it fails until the grant exists.

`check:wtari --pre-grant` prints the expected transaction (to, value 0, operation 0 = CALL, data, and a decoded description), computed from the CREATE2-proven addresses rather than from deployment records.

- [ ] `check:wtari --pre-grant` passed on a Safe signer's machine, using its own RPC, before signing (who / when / RPC: )
- [ ] The queued Safe transaction matches the printed one byte for byte: `to`, `value`, `operation` and `data` (checked by: )

- [ ] Pending `grantRole(MINTER_ROLE, wTARIController)` Safe transaction executed (Safe tx hash: )

## Checks

`check:wtari` is a deploy-time review. Rotating a mint Safe or any role, setting OFT peers or enforced options, or retiring the chain (revoking `MINTER_ROLE`) makes it fail by design; each such Safe operation needs its own review.

All on-chain reads go through the compiled ABIs at the CREATE2-proven addresses, never through deployment-record ABIs. `check:wtari` also proves how every contract was created: it recomputes each record's CREATE2 address from the compiled creation code, the fixed salts, the pinned LayerZero endpoint and the config (initializer calldata built by the same function `deploy:wtari` uses), requires the CREATE2 factory to have the deterministic-deployment-proxy code, and requires the wTARI, controller and bridge proxy creation transactions to be successful (receipt status 1) calls to that factory with exactly that salt and init code. The bridge's start block exported to the package (`wTARIBridgeStartBlock`) comes from that proven transaction, and `export-deployments` writes the wTARI entries (every record named `wTARI*`, as one set) only if `check:wtari` passes for new or changed addresses; otherwise it still writes the other entries, omits all wTARI keys for that chain, warns, and exits non-zero. An unchanged, already exported wTARI set is kept without re-checking. It also checks: every immutable of the implementations is on an explicit allow-list checked via its getter (`endpoint`, `decimalConversionRate == 10^(decimals - sharedDecimals)`); `name()` `WrappedTARI`, `symbol()` `wTARI`, `decimals()` 18; the EIP-712 domain (`wTARI`, `1`, this chain id, the wTARI proxy); `totalSupply()` 0 while the controller lacks `MINTER_ROLE` (printed afterwards).

- [ ] Clones differ from their wXTM sources by names, the `wTARI` symbol, and only these intentional changes (`npm run test:hardhat`, "wTARI clones", which lists them exactly):
  - wTARIController: a budget for `mintLowAmount` per fixed 24h window (`block.timestamp / 1 days`), not a rolling one, so up to 2x the limit can be minted across a window boundary (`lowMintDailyLimit`, set at initialize from `lowMintDailyLimit` in `deploy/wtari/<chainId>.json` in whole tokens, changeable by `DEFAULT_ADMIN_ROLE` via `setLowMintDailyLimit`, event `LowMintDailyLimitSet`, error `LowMintDailyLimitExceeded`).
  - wTARIBridge: `targetTariAddress` must be 1..128 bytes (error `InvalidTargetTariAddress`).
  - Shared `extensions/EIP3009.sol`: authorizations expire at `validBefore` (`block.timestamp >= validBefore` reverts). Deployed wXTM bytecode is unaffected.
- [ ] Initializers cannot be re-run (`wTARITest.test_initializers_cannot_be_rerun`, hardhat "initializers cannot be re-run").
- [ ] Proxy admin and implementation addresses recorded above (printed by `check:wtari`).
- [ ] `npm run check:wtari -- --chain <chainId>` passes. It checks:
  - mint-low, mint-high and proxy-admin Safes: official SafeProxy runtime code (v1.3.0 / v1.4.1 / v1.5.0 code hashes), an official Safe singleton for this chain (from `@safe-global/safe-deployments`), no modules, no transaction or module guard; mint Safes have the owners and threshold of the reference Ethereum Safes (hard-coded in `tasks/wtari.ts` per `referenceChainId`) and are two different Safes; the proxy-admin Safe has threshold >= 2 and is neither mint Safe;
  - `hasRole` grants match this chain's Safes and every role holder has code on this chain;
  - every `RoleGranted` ever emitted on wTARI and wTARIController since creation is for an expected (role, account) pair, even if later revoked, every expected pair is held, and `MINTER_ROLE` was granted exactly once, to the controller;
  - every mint (`Transfer` from address 0) on wTARI happened in a transaction whose receipt contains an `ExecutionSuccess` event from the mint-low or mint-high Safe (so relayed Safe executions pass);
  - neither the deployer (the `from` of the creation transaction, read from the chain) nor the current signer holds any role or ownership;
  - `wTARI.endpoint()` is the official LayerZero EndpointV2 for the chain's eid, and `wTARI.owner()`, `wTARIProxyAdmin.owner()` and that endpoint's `delegates(wTARI)` are the proxy-admin Safe;
  - wTARIBridge's `wTARI` and wTARIController's `wtari` storage slots (from the compiler storage layout) hold the wTARI proxy address;
  - `msgInspector()` and `preCrime()` are unset, and no `PeerSet` or `EnforcedOptionSet` event was ever emitted (logs from the creation block, read from the chain);
  - every proxy, the implementation at each proxy's EIP-1967 implementation slot, and the `wTARIProxyAdmin` at the proxies' admin slot have the compiled runtime bytecode (immutables masked);
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

A new chain needs `deploy/wtari/<chainId>.json` plus these pinned trust anchors:

- The chain must be listed by the pinned `@safe-global/safe-deployments` devDependency (exact version). If it is not, `deploy:wtari` and `check:wtari` refuse with `not an official Safe singleton on chain <chainId>`; the fix is bumping that devDependency, not a code change.
- The chain's LayerZero EndpointV2 must be pinned in `LZ_ENDPOINTS` in `tasks/wtari.ts`, keyed by eid with its chain id; otherwise both tasks refuse with `pin the endpoint for eid <eid> in tasks/wtari.ts`. The pin must agree with the exactly pinned `@layerzerolabs/lz-evm-sdk-v2`, and the config's `network.eid` must belong to the chain. This is a reviewed code change.
- Safes on a SafeProxy version other than v1.3.0 / v1.4.1 / v1.5.0 need their proxy runtime code hash added to `SAFE_PROXY_CODE_HASHES` in `tasks/wtari.ts`.

## Accepted residual risks

- Reference Safe owners are compared by address only. An owner that is itself a contract (e.g. another Safe) is only as trustworthy as its own configuration.
- An explorer's "already verified" result is accepted when the published compiler version and contract name match ours; the full published source is not compared.
- Burns are 18-decimal, Tari amounts are 6-decimal: the off-chain processor must handle the sub-1e12 remainder of a burned amount (inherited from wXTM).
- A genuine SafeProxy can still have been set up through a setup-time delegatecall that leaves hidden owner state; `check:wtari` cannot see storage the Safe does not expose (R2-3).
- Once the Safe sets OFT peers, inbound LayerZero messages mint wTARI outside the controller's tiered limits. Any peer configuration is a proxy-admin Safe decision, and `check:wtari`'s guarantees end once peers exist (it fails on any `PeerSet`).
- Each check trusts the single RPC it is given. Signers should use an independent RPC on the second machine.

## Recovery: CREATE2 address already taken

All deployment inputs are public, so anyone can deploy the same implementation or proxy to the deterministic address first, and hardhat-deploy then stops with "already deployed". If that happens: confirm on chain that the existing contract's bytecode, EIP-1967 admin/implementation slots, owner and roles are exactly what `deploy:wtari` would have produced; if so, save it as the deployment record and run `check:wtari`. If anything differs, do not use it: change the salt version in `tasks/wtari.ts` (e.g. `wTARI-v0.0.2`) and deploy again.

Signed off by (name, date):
