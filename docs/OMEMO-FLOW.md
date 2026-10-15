# OMEMO 发送与接收流程

## 发送流程

1. UI 调用 chatService.sendOmemo()
2. chatService 调用 OmemoCore.encryptMessage()
3. DeviceManager 获取对方所有设备
4. DeviceManager 获取自己其他设备
5. SessionManager 为每个设备 ensureSession()
6. OmemoEncryptor 生成 messageKey
7. AES-GCM 加密正文 payload
8. Signal session 分别加密 messageKey
9. OmemoXml 生成标准 OMEMO XML
10. messageSender 发送 XMPP stanza

## 接收流程

1. messageReceiver 收到 stanza
2. 判断是否有 OMEMO encrypted block
3. OmemoCore.decryptMessage()
4. OmemoXml 解析 sid/rid/key/payload
5. 找到 rid == 当前 deviceId 的 key
6. SessionManager 解开 messageKey
7. AES-GCM 解开 payload
8. UI 显示本地明文
