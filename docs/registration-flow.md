# Registration Flow

## Web registration
1. User submits JID + password to `/auth/register`.
2. API validates format and password policy.
3. API calls `prosodyctl register`.
4. On success, API returns `{ ok: true, jid: ... }`.

## Server permission prerequisite
- The API service user (`liaot`) must be in the `prosody` group.
- Installer applies this with: `usermod -aG prosody liaot`.
- If this is missing, registration can fail with permission errors.

## Friend flow
1. A adds B's JID and sends first message.
2. B receives message and can `Accept / Reject / Block`.
3. Accept: both become contacts.
4. Reject: requester gets feedback notification.
5. Block: requester cannot send until unblocked.
