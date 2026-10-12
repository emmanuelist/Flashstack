# `deployments/` — read this before running anything in here

## The rule

**Never run `clarinet deployments apply --mainnet` from this repository, with or
without `-d`.** Until D6 (`docs/security/CONTRACT_INVENTORY.md` §7.3) is fixed, the
plan `clarinet` computes from the current `Clarinet.toml` publishes 57 contracts, 30
of them from `contracts/test/` — localized copies and test fixtures, not canonical
sources. That includes the five undeployed audit-track successors
(`flashstack-pool-v3`, `flashstack-stx-pool-v3`, `flashstack-sbtc-pool-v3`,
`flashstack-sbtc-core-v2`, `flashstack-stx-core-v2`). Contract names can't be reused,
so one such run would permanently occupy FlashStack's real mainnet names with test
builds bound to a mock, flash-mintable `sbtc-token`, for every machine key.

This is **not** about any plan file — it's `Clarinet.toml` itself, regenerated fresh
every time. Deleting or archiving a stale plan file does not change it. See
`docs/security/CONTRACT_INVENTORY.md` D5 and D6 for the full evidence, including why
two earlier attempts to describe this mechanism from reading clarinet's source were
both wrong, and what running clarinet for real (in an isolated container) actually
showed.

Guarded in CI by `tests/mainnet-plan-guard.test.ts` (#76): it fails if the known set
of 30 `contracts/test/` publishes changes in either direction, and carries the real
target — zero `contracts/test/` paths in the plan — as an expected failure until D6
lands.

## What to do instead

- **Mainnet publishes go through an explicit, reviewed plan**, passed with
  `-p <path>`, never the bare `--mainnet` default/auto-generate path, and never `-d`
  against a freshly generated plan.
- Prefer the `scripts/` deploy path for anything that needs repeatable, reviewable
  evidence (see `docs/TESTNET_STAGING.md` for the gate this follows on testnet).
- If you think you need to run `apply --mainnet` directly for some reason this
  doesn't cover, stop and ask the Security & Contract Lead first — this doc is
  deliberately conservative because the failure mode is irreversible.

## What's in this directory

- `default.devnet-plan.yaml`, `default.simnet-plan.yaml`, `default.testnet-plan.yaml`,
  `testnet-plan.yaml`, `testnet-current-gen-plan.yaml` — network-specific plans.
  `default.testnet-plan.yaml` is a non-issue by comparison: it targets the well-known
  public Clarinet devnet deployer, a key nobody on this project holds.
- `archive/` — historical plans kept for the record, explicitly not meant to be run.
  Each has its own header explaining why. See `gen1-mainnet-plan-2026-09-22.yaml`.
