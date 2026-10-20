# LyaoTalk 2.0 Test Checklist

## UI Connectivity

- [ ] Connect button has a working handler.
- [ ] Send plaintext button has a working handler.
- [ ] Send OMEMO button has a working handler.
- [ ] Trust device button has a working handler.
- [ ] Revoke device trust button has a working handler.
- [ ] Republish device list button has a working handler.
- [ ] Republish bundle button has a working handler.

## OMEMO

- [ ] Identity remains stable after restart.
- [ ] `deviceId` remains stable after restart.
- [ ] Device list can be published.
- [ ] Bundle can be published.
- [ ] A session can be established.
- [ ] The first OMEMO message succeeds.
- [ ] Fan-out to multiple devices succeeds.
- [ ] Conversations interoperability succeeds.
