// index.js
require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');

// Vision：解析課表圖片
const { parseScheduleImage } = require('./src/visionParser');
const { saveUserDefaultCalendar } = require('./src/calendarStore');

// 之後會根據大家的可用時間計算「建議開會時段」，相關演算法都放在 src/scheduler.js
const {
  generateTimeSlots,
  mergeAvailabilities,
  findBestSlotsWithPartial,
} = require('./src/scheduler'); // 目前還沒用到，但未來會議排程會用到

// 從 .env 抓設定（很重要：.env 每個 key 要一行）
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
  console.warn(
    '⚠️ CHANNEL_SECRET 或 CHANNEL_ACCESS_TOKEN 尚未設定，目前不啟用 LINE 回覆功能，只提供 /health 檢查。',
  );

  // 還沒設定金鑰時的暫時 stub，不要讓程式因為 middleware 爆掉
  app.post('/webhook', (req, res) => {
    console.warn('⚠️ 收到 /webhook 請求，但 LINE client 尚未初始化（尚未設定金鑰）。');
    res.status(200).json({ message: 'LINE client not configured yet' });
  });
}

// ===== 小工具函式們（之後正式的「建議開會時間」功能會用到） =====

// 小工具：給最後一格 slot（例如 20:30）、slotMinutes=30 → 算出結束時間（例如 21:00）
function computeEndTime(lastSlot, slotMinutes) {
  const [hh, mm] = lastSlot.split(':').map(Number);
  const totalMinutes = hh * 60 + mm + slotMinutes;
  const endHour = Math.floor(totalMinutes / 60);
  const endMin = totalMinutes % 60;
  return `${endHour.toString().padStart(2, '0')}:${endMin.toString().padStart(2, '0')}`;
}

// 如果沒有任何符合門檻的會議時間，就算出「大家錯開的最大區段」
// 例如 20:00-22:00（只要有人有空就算進來）
function computeFallbackRange(merged, slotMinutes) {
  const slotKeys = Object.keys(merged);
  const indicesWithSomeone = [];

  slotKeys.forEach((slot, idx) => {
    const avail = merged[slot]?.available || [];
    if (avail.length > 0) {
      indicesWithSomeone.push(idx);
    }
  });

  if (indicesWithSomeone.length === 0) {
    return null; // 完全沒有任何人有空
  }

  const startIdx = Math.min(...indicesWithSomeone);
  const endIdx = Math.max(...indicesWithSomeone);

  const startSlot = slotKeys[startIdx];
  const endTime = computeEndTime(slotKeys[endIdx], slotMinutes);

  return { start: startSlot, end: endTime };
}

// result 來自 findBestSlotsWithPartial，merged 是 mergeAvailabilities 的結果
// 目前還沒在 handleEvent 裡實際呼叫，之後實作「開會時間？」時會用到
function formatMeetingSuggestion(result, merged, dayLabel = '星期二', slotMinutes = 30) {
  // ⭐ 情境 3：完全沒有符合「人數門檻」的會議時間
  if (
    !result ||
    !Array.isArray(result.candidates) ||
    result.candidates.length === 0 ||
    result.bestTotalCanAttend === 0
  ) {
    const fallback = computeFallbackRange(merged, slotMinutes);
    if (!fallback) {
      return '目前完全找不到大家有空的時間，要不要請大家多提供一點可行時段呢～';
    }
    return `目前沒有可以一起開會的時間，要不要再看看${dayLabel}${fallback.start}-${fallback.end} 有沒有人能把事情排開呢～`;
  }

  const candidate = result.candidates[0]; // 先拿第一個最佳候選
  const slots = candidate.slots;
  const start = slots[0];
  const end = computeEndTime(slots[slots.length - 1], slotMinutes);

  const full = candidate.fullAvailable || [];
  const partial = candidate.partialAvailable || [];
  const unavailable = candidate.unavailable || [];
  const totalUsers =
    result.totalUsers || full.length + partial.length + unavailable.length;

  // ⭐ 情境 1：所有人全程有空
  if (full.length === totalUsers && partial.length === 0 && unavailable.length === 0) {
    return `建議會議時間：${dayLabel} ${start}–${end}\n全員到齊`;
  }

  // ⭐ 情境 2 + 一般情況：有人部分出席 / 有人不能到
  const lines = [];
  lines.push(`建議會議時間：${dayLabel} ${start}–${end}`);

  // 只講「有問題的人」，不講可以全程的人
  // 對每個 partial user 算出是「晚到」還是「早走」
  partial.forEach((userId) => {
    const availableIndices = [];
    slots.forEach((slot, idx) => {
      const avail = merged[slot]?.available || [];
      if (avail.includes(userId)) {
        availableIndices.push(idx);
      }
    });

    if (!availableIndices.length) return;

    const firstIdx = Math.min(...availableIndices);
    const lastIdx = Math.max(...availableIndices);

    // 第一格不是 0 → 會晚到
    if (firstIdx > 0) {
      const arriveTime = slots[firstIdx];
      lines.push(`${userId} ${arriveTime}到`);
    }

    // 最後一格不是最後 → 會提早走
    if (lastIdx < slots.length - 1) {
      const leaveSlot = slots[lastIdx];
      const leaveTime = computeEndTime(leaveSlot, slotMinutes);
      lines.push(`${userId} ${leaveTime}走`);
    }
  });

  // 完全不能來的人
  unavailable.forEach((userId) => {
    lines.push(`${userId} 不能到`);
  });

  return lines.join('\n');
}

// 處理每一個 LINE event（只有在 client 存在的情況下才會被呼叫）
async function handleEvent(event) {
  if (!client) {
    console.warn('⚠️ handleEvent 被呼叫，但 client 尚未初始化。');
    return Promise.resolve(null);
  }

  // 只處理 message 類型（文字 / 圖片）
  if (event.type !== 'message') {
    return Promise.resolve(null);
  }

  // ===== 圖片訊息：課表 screenshot → 解析 + 存常用行事曆 =====
  if (event.message.type === 'image') {
    try {
      // 從 LINE 下載圖片內容
      const stream = await client.getMessageContent(event.message.id);
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      const userId = event.source?.userId || 'unknown-user';

      const parsed = await parseScheduleImage(buffer, userId);

      if (!parsed) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '❌ 無法解析課表圖片，能否傳更清楚一點的版本？',
        });
      }

      // 存成這個使用者的常用行事曆
      saveUserDefaultCalendar(userId, parsed);

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '📚 已成功解析課表並儲存為你的常用行事曆！',
      });
    } catch (err) {
      console.error('❌ 處理圖片時發生錯誤：', err);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 處理圖片時發生錯誤，稍後再試試看～',
      });
    }
  }

  // ===== 文字訊息：目前先單純 echo，之後再改成「我 18:00–20:00 有空」等邏輯 =====
  if (event.message.type === 'text') {
    const text = event.message.text.trim();

    const replyText = `你說了：「${text}」`;

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: replyText,
    });
  }

  // 其他型態先忽略
  return Promise.resolve(null);
}

// 簡單 health check，讓你不用 LINE 也可以確認伺服器有跑起來
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});
