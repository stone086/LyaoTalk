#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
python3 - <<'PY'
import re
from pathlib import Path
src = Path('apps/web/src')
i18n_path = src / 'utils' / 'i18n.ts'
text = i18n_path.read_text(encoding='utf-8')
en_block = text.split('const zhCN')[0]
zh_block = text.split('const messages')[0].split('const zhCN')[1]
en = set(re.findall(r'\n\s*"([^"]+)":\s*"', en_block))
zh = set(re.findall(r'\n\s*"([^"]+)":\s*"', zh_block))
if en != zh:
    print('[FAIL] i18n key mismatch')
    print('missing in zh:', sorted(en - zh))
    print('extra in zh:', sorted(zh - en))
    raise SystemExit(1)
used = set()
for path in list(src.rglob('*.tsx')) + list(src.rglob('*.ts')):
    if path.name == 'i18n.ts':
        continue
    s = path.read_text(encoding='utf-8', errors='ignore')
    for m in re.finditer(r"\bt\(\s*['\"]([^'\"]+)['\"]", s):
        used.add(m.group(1))
# false positives from stanza-builder .t("...") calls, not i18n t()
ignore = {'0','1','http://jabber.org/protocol/muc#roomconfig','urn:xmpp:mam:2'}
missing = sorted((used - en) - ignore)
if missing:
    print('[FAIL] missing i18n keys used by UI:')
    for key in missing:
        print('  -', key)
    raise SystemExit(1)
empty = []
for block_name, block in [('en-US', en_block), ('zh-CN', zh_block)]:
    for key, value in re.findall(r'\n\s*"([^"]+)":\s*"([^"]*)"', block):
        if not value.strip():
            empty.append(f'{block_name}:{key}')
if empty:
    print('[FAIL] empty translations:', empty)
    raise SystemExit(1)
print(f'[OK] i18n packs are complete: {len(en)} keys in en-US and zh-CN; {len(used)} static UI keys checked')
PY
