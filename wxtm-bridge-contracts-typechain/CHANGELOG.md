# Changelog

## 0.2.2

Built and published by `.github/workflows/publish.yml` from the tag `@tari-project/wxtm-bridge-contracts@v0.2.2`, with npm provenance.

- `deployments.json` now holds exactly the records committed in `deployments/<network>/*.json` (plus `wTARIBridgeStartBlock`). The build checks this before packing.
  - `DefaultProxyAdmin` is corrected on all three chains. 0.2.0 and 0.2.1 shipped LayerZero's `DefaultProxyAdmin` instead of ours: on mainnet `0x87D8Ee0bAe7d352bc05C90B2d3fA3467D6c2357b` instead of `0x67d3d893ce36D9628B82Be2860Cd5c021227B3bE`.
  - The 209 LayerZero entries (endpoints, libraries, executors and their proxy admins) are removed.
  - **Base Sepolia (84532) no longer has `wXTMBridge`.** 0.2.0 and 0.2.1 shipped `0x52610316B50238d0f6259691762179A3d8E87908`, a retired testnet bridge with no deployment record. `getDeployments(84532)` is now typed with `wXTMBridge?: undefined`.
- The package ships only the compiled `.js` and `.d.ts` files, `deployments.json`, the README and this changelog. 0.2.0 and 0.2.1 also shipped the `.ts` sources and `tsconfig.json`.

## 0.2.1 (2026-11-17)

Tag `@tari-project/wxtm-bridge-contracts@v0.2.1` (`d9970ce`), published with npm provenance.

- Adds the Base Sepolia (84532) wTARI entries: `wTARI`, `wTARIController`, `wTARIBridge`, their proxies and implementations, `wTARIProxyAdmin` and `wTARIBridgeStartBlock` 59577684.

## 0.2.0 (2026-11-10)

Published by hand, without provenance, and not tagged at publish time. Its contents are byte-identical to `a72ea382c8a0183fa736e8b19f42592a3995e3dd` (`development` when it was published). It is tagged afterwards as `release/wxtm-bridge-contracts-0.2.0` on that commit. That name deliberately does not match the publish workflow's tag pattern, so the tag cannot trigger a publish run.

- Adds the wTARI types and `getWtariChains()`; `getDeployments()` returns the optional wTARI fields.
