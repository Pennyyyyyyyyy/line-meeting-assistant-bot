// index.js
require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
};

const app = express();

let client = null;

// 有設定 secret & token 才初始化 LINE client & 真正的 webhook
if (config.channelSecret && config.channelAccessToken) {
  console.log('✅ 已設定 CHANNEL_SECRET / CHANNEL_ACCESS_TOKEN，啟用 LINE Webhook 功能。');
  client = new line.Client(config);

  // 真正的 LINE webhook（驗簽章 + 處理事件）
  app.post('/webhook', line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
      .then((result) => res.json(result))
      .catch((err) => {
        console.error('❌ Error in webhook handler:', err);
        res.status(500).end();
      });
  });
} else {
  console.warn('⚠️ CHANNEL_SECRET 或 CHANNEL_ACCESS_TOKEN 尚未設定，目前不啟用 LINE 回覆功能，只提供 /health 檢查。');

  // 還沒設定金鑰時的暫時 stub，不要讓程式因為 middleware 爆掉
  app.post('/webhook', (req, res) => {
    console.warn('⚠️ 收到 /webhook 請求，但 LINE client 尚未初始化（尚未設定金鑰）。');
    res.status(200).json({ message: 'LINE client not configured yet' });
  });
}

// 處理每一個 LINE event（只有在 client 存在的情況下才會被呼叫）
function handleEvent(event) {
  if (!client) {
    console.warn('⚠️ handleEvent 被呼叫，但 client 尚未初始化。');
    return Promise.resolve(null);
  }

  // 只處理文字訊息
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userText = event.message.text;
  const replyText = `你說了：「${userText}」`;

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: replyText,
  });
}

// 簡單 health check，讓你不用 LINE 也可以確認伺服器有跑起來
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});
