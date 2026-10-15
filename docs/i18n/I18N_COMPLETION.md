# I18N completion policy

LiaoT currently ships two UI language packs:

- `en-US`
- `zh-CN`

## Release gate

Every release must pass:

```bash
bash scripts/i18n_validate.sh
cd apps/web && npm test -- --run
```

The gate checks that:

1. English and Simplified Chinese use the exact same key set.
2. No translation value is empty.
3. All static UI calls of `t("...")` have a language-pack key.

## Rules for new UI strings

- Do not hardcode user-facing strings in React components.
- Add every new string to both `en-US` and `zh-CN`.
- Use placeholders for variable values, for example `{fileName}` or `{message}`.
- Run `scripts/i18n_validate.sh` before packaging.

## Known limitations

The static checker intentionally focuses on literal `t("key")` calls and obvious UI strings. Some non-UI strings in XMPP stanza builders also use `.t("...")`; the checker ignores known protocol constants.

A full product translation review still requires manual browsing in both languages during staging.
