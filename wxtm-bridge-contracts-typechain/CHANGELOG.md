# Changelog

## 0.3.0

Built and published by `.github/workflows/publish.yml` from the tag `@tari-project/wxtm-bridge-contracts@v0.3.0`, with npm provenance. This is a minor bump because the release breaks consumers, so `^0.2.x` ranges do not pick it up.

### Breaking changes

- **Base Sepolia (84532) no longer has `wXTMBridge`.** 0.2.0 and 0.2.1 shipped `0x52610316B50238d0f6259691762179A3d8E87908`, a retired testnet bridge with no deployment record.
- **`WxtmChain` no longer includes 84532.** It is now `1 | 11155111`. `getDeployments(84532)` has its own overload (`WxtmChainWithoutBridge`), which returns `wXTMBridge?: undefined`. Code that reads `getDeployments(84532).wXTMBridge` as an address no longer compiles.
- **`DefaultProxyAdmin` changed on all three chains.** 0.2.0 and 0.2.1 shipped LayerZero's `DefaultProxyAdmin` instead of ours:
  - mainnet: `0x67d3d893ce36D9628B82Be2860Cd5c021227B3bE` (was `0x87D8Ee0bAe7d352bc05C90B2d3fA3467D6c2357b`);
  - Sepolia: `0x9955F709e17c7476904CaF3229061db938CE71Bf` (was `0xe4BA40cF8A8B9d0FefC76Dc594A58AEDa574Cb45`);
  - Base Sepolia: `0x4659Ec87b852C7BcAA2C2988f81e1c20edADab65` (was `0xa78A78a13074eD93aD447a26Ec57121f29E8feC2`).
- **The 209 LayerZero keys are removed from `deployments.json`.** These were endpoints, libraries, executors and their proxy admins.
- **The `.ts` sources and `tsconfig.json` are no longer shipped.** The package contains only the compiled `.js` and `.d.ts` files, `deployments.json`, the README and this changelog.

### Changes

- `deployments.json` now holds exactly the records committed in `deployments/<network>/*.json`, plus `wTARIBridgeStartBlock`. The build checks this before packing.

## 0.2.1 (2026-11-17)

Tag `@tari-project/wxtm-bridge-contracts@v0.2.1` (`d9970ce`), published with npm provenance.

- Adds the Base Sepolia (84532) wTARI entries: `wTARI`, `wTARIController`, `wTARIBridge`, their proxies and implementations, `wTARIProxyAdmin` and `wTARIBridgeStartBlock` 59577684.

## 0.2.0 (2026-11-10)

Published by hand, without provenance, and not tagged at publish time. Its contents are byte-identical to `a72ea382c8a0183fa736e8b19f42592a3995e3dd` (`development` when it was published). It is tagged afterwards as `release/wxtm-bridge-contracts-0.2.0` on that commit. That name deliberately does not match the publish workflow's tag pattern, so the tag cannot trigger a publish run.

- Adds the wTARI types and `getWtariChains()`; `getDeployments()` returns the optional wTARI fields.
