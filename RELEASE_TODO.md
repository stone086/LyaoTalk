# LiaoT release todo

Current candidate: `2.3.5-staging-complete`

## Completed before staging

- Preflight config wizard and strict `.env` validation.
- Evidence kit and staging result locations.
- English/Simplified Chinese language-pack key parity.
- i18n release gate: `scripts/i18n_validate.sh`.
- Post-2.3.3 execution plan: `docs/roadmap/POST_2.3.3_EXECUTION_PLAN.md`.

## Real staging completed for 2.3.5

- Clean VPS install.
- Stage 0 server validation.
- Browser smoke test.
- OMEMO interop with Conversations / Gajim / Dino.
- k6 performance baseline.
- Browser compatibility matrix.
- Prometheus / Alertmanager target and alert test.
- Backup and restore drill.
- Evidence gate pass.
