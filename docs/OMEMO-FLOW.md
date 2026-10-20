# OMEMO Send and Receive Flow

## Sending

1. The UI calls `chatService.sendOmemo()`.
2. `chatService` calls `OmemoCore.encryptMessage()`.
3. `DeviceManager` retrieves all recipient devices.
4. `DeviceManager` retrieves the sender's other devices.
5. `SessionManager` calls `ensureSession()` for each device.
6. `OmemoEncryptor` generates a `messageKey`.
7. AES-GCM encrypts the message body as the payload.
8. Each Signal session encrypts the `messageKey` for its device.
9. `OmemoXml` generates the standard OMEMO XML.
10. `messageSender` sends the XMPP stanza.

## Receiving

1. `messageReceiver` receives the stanza.
2. It checks for an OMEMO encrypted block.
3. It calls `OmemoCore.decryptMessage()`.
4. `OmemoXml` parses the `sid`, `rid`, key, and payload.
5. It selects the key whose `rid` matches the current `deviceId`.
6. `SessionManager` decrypts the `messageKey`.
7. AES-GCM decrypts the payload.
8. The UI displays the plaintext locally.
