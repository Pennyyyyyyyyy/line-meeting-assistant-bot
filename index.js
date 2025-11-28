// index.js
require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');
const {
  generateTimeSlots,
  mergeAvailabilities,
  findBestSlotsWithPartial,
} = require('./src/scheduler');

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

// ===== 小工具函式們 =====

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
function handleEvent(event) {
  if (!client) {
    console.warn('⚠️ handleEvent 被呼叫，但 client 尚未初始化。');
    return Promise.resolve(null);
  }

  // 只處理文字訊息
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const text = event.message.text.trim();

  // ✅ 特殊指令：用假資料測試「建議會議時間」三種情境格式
  if (text === '測試會議') {
    // 這裡先用你情境 2 的假資料：
    // A, B 可以所有時間在；C 20:30 要提早走；D 20:30 才會到
    const slots = generateTimeSlots({
      startHour: 20,
      endHour: 22, // 會產生 20:00, 20:30, 21:00, 21:30
      slotMinutes: 30,
    });

    const availabilities = [
      {
        userId: 'A',
        status: 'available',
        startTime: '20:00',
        endTime: '21:00', // A 全程 20:00–21:00
      },
      {
        userId: 'B',
        status: 'available',
        startTime: '20:00',
        endTime: '21:00', // B 全程 20:00–21:00
      },
      {
        userId: 'C',
        status: 'available',
        startTime: '20:00',
        endTime: '20:30', // C 20:30 要走
      },
      {
        userId: 'D',
        status: 'available',
        startTime: '20:30',
        endTime: '21:00', // D 20:30 才到
      },
    ];

    const merged = mergeAvailabilities(slots, availabilities);
    const result = findBestSlotsWithPartial(merged, 2); // 2 格 = 1 小時 20:00–21:00

    const messageText = formatMeetingSuggestion(result, merged, '星期二', 30);

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: messageText,
    });
  }

  // 其他文字：維持原本 echo 行為
  const replyText = `你說了：「${text}」`;

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
