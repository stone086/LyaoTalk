# LyaoTalk Security Incident Response Runbook

Version: 2.2.0 ops-runbook

## Severity levels

| Level | Example | First response |
|---|---|---|
| P0 | token leak, DB leak, admin account takeover | isolate, rotate secrets, revoke tokens |
| P1 | repeated admin brute force, suspicious CSP violations | block source, inspect audit logs |
| P2 | single user compromise | disable user, revoke sessions |
| P3 | failed scan/no exploit | document and monitor |

## P0: token or database leak

Immediate actions:

```bash
# 1. isolate external access if needed
sudo nginx -t && sudo systemctl stop nginx

# 2. rotate JWT secret
openssl rand -hex 32 | sudo tee /tmp/lyaotalk-new-secret
sudo sed -i "s/^SECRET_KEY=.*/SECRET_KEY=$(cat /tmp/lyaotalk-new-secret)/" /opt/lyaotalk-src/.env

# 3. revoke refresh tokens
sudo -u postgres psql lyaotalk -c "DELETE FROM refresh_tokens;"

# 4. restart API
sudo systemctl restart lyaotalk-api
```

Then inspect logs:

```bash
sudo journalctl -u lyaotalk-api --since "24 hours ago" --no-pager
sudo -u postgres psql lyaotalk -c "SELECT * FROM audit_logs WHERE created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 200;"
```

Notify users and force password rotation if password material may be affected.

## P1: admin brute force

```bash
sudo -u postgres psql lyaotalk -c "SELECT actor, COUNT(*) FROM audit_logs WHERE action='admin_login_failed' AND created_at > NOW() - INTERVAL '1 hour' GROUP BY actor ORDER BY COUNT(*) DESC;"
sudo journalctl -u nginx --since "1 hour ago" --no-pager
```

Block at firewall/nginx/fail2ban, then keep monitoring.

## P1: CSP violation spike

```bash
sudo journalctl -u lyaotalk-api --since "1 hour ago" --no-pager | grep csp_violation || true
curl -fsS http://127.0.0.1:8000/metrics | grep csp
```

Classify as either legitimate asset blocked by CSP or possible injection attempt.

## P2: user account compromise

- Disable the user.
- Revoke their refresh tokens.
- Inspect recent audit logs and messages metadata.
- Ask user to rotate password and verify OMEMO device fingerprints.

## Communication checklist

- What happened.
- What data may be affected.
- What has been rotated/revoked.
- What user action is required.
- When next update will be posted by the operator.
