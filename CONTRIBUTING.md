# Contributing

Thanks for improving LiaoT.

## Local Setup
1. Clone the repository.
2. Copy `.env.example` to `.env`.
3. Install dependencies:
   - `cd apps/web && npm ci`
   - `cd apps/api && python -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt`
4. Run checks before opening a PR:
   - `cd apps/web && npm run build`
   - `cd apps/api && .venv/bin/pytest -q`

## Branching and Commits
- Keep branches focused on a single topic.
- Use clear, scoped commit messages.
- Avoid mixing feature work with large refactors unless required.

## Pull Request Requirements
- Explain what changed and why.
- Call out behavior changes and migration impact.
- Include screenshots or short recordings for UI changes.
- Mention security/ops impact when touching install, nginx, firewall, auth, or backup logic.

## Testing Expectations
- Add or update backend tests for behavior changes.
- Confirm frontend build succeeds.
- If a test is not practical, explain the validation method in the PR.

## Docs and Configuration
- Update `README.md`, `CHANGELOG.md`, and relevant docs under `docs/` when behavior changes.
- Keep `.env.example` aligned with runtime configuration.

## Security
- Never commit real secrets, tokens, or private keys.
- Use placeholders in examples.
- Preserve least-privilege defaults when editing service definitions.
