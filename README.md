# opt2-tealbrick-knowledge

Teal Brick opt2: Knowledge miniapp, built on the Miniapp SDK.

**Status: opt2 build (clean-room v2 of Teal Brick), work in progress.** This repository is part of the opt2 build and lives under `Martin-Atrin` during the build; it moves to the Teal Brick organisation as one clean commit when opt2 is released. It is not the current production system.

Owner lane: Lead · Knowledge.

## What it is

Knowledge gives agents memory and documents, with data in the customer's own deployment.

- Canonical documents (collections, revisions, comments, links, attachments) live in Knowledge, engine-independent.
- Document bodies are projected into the memory engine. Engines are pinned, unmodified upstream services: GBrain (memory), Open Notebook (research); Hindsight later.
- Areas are grant scopes: one memory garden per agent and one shared company area.
- Auth, grants, receipts, settings and backups come from the Miniapp SDK. Knowledge has no own auth.

## Layout

- `src/engines/` engine adapters (one interface, one adapter per upstream engine)
- `src/store/` canonical document store (SQLite)
- `skills/` manifest-declared skills (how to work with the memory system, per engine)
- `test/` unit tests (`npm test`); `npm run typecheck`

Status: scaffold. Built against the frozen opt2 specs in phase P1.

## No secrets policy

This repository is public. It must never contain secrets or personal data:

- No API keys, tokens, passwords, private keys, deployment secrets, `.env` files or connection strings. Use `.env.example` with placeholder values only.
- Runtime secrets live in the deployment platform (Railway variables, Woodpecker secrets) and are copied between services without printing them.
- No personal names, private agent configurations or customer data.
- Every push runs a secret scan (`.woodpecker/secret-scan.yaml`, gitleaks). GitHub secret scanning with push protection is enabled. Optional local guard: `pre-commit install`.
- If a secret is committed anyway: rotate it first, then remove it from history.

## CI

Woodpecker CI (shared opt2 pipeline template from `opt2-tealbrick-platform`).

## Language

New code is TypeScript (Node 24+). Swift only where the macOS app requires it.
