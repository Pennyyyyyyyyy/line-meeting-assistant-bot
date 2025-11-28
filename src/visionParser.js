// src/visionParser.js
const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * 解析課表圖片 → 回傳 availability JSON
 * 回傳格式：
 * [
 *   {
 *     "userId": "Penny",
 *     "dayOfWeek": "Mon",
 *     "status": "unavailable",
 *     "startTime": "09:00",
 *     "endTime": "12:00"
 *   }
 * ]
 */
async function parseScheduleImage(imageBuffer, userId = 'Unknown') {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('⚠️ 尚未設定 OPENAI_API_KEY，跳過 Vision 解析。');
    return null;
  }

  const base64Image = imageBuffer.toString('base64');

  const prompt = `
你是一個專門幫使用者解析課表 screenshot 的 AI。
請從圖片中找出「上課的時間」。
使用者只要上課，就是 unavailable，有空堂才是 available。

請輸出嚴格 JSON 格式 Array，每一筆如下：
{
  "userId": "${userId}",
  "dayOfWeek": "Mon",          // Mon/Tue/Wed/Thu/Fri/Sat/Sun
  "status": "unavailable",     // unavailable = 上課；available = 空堂（如有需要可以補）
  "startTime": "09:00",        // 24 小時制 HH:MM
  "endTime": "12:00"
}

不要額外說明。只輸出 JSON。
`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: '你是會解析課表圖片的 AI 助手，請嚴格輸出 JSON。',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              // ⭐ 這裡一定要是物件 { url: ... }，不能只是一條字串
              url: `data:image/png;base64,${base64Image}`,
            },
          },
        ],
      },
    ],
  });

  const rawContent = response.choices[0].message.content;

  // 在 chat.completions API 裡，content 通常是字串，但保險處理一下 array 情況
  let text;
  if (Array.isArray(rawContent)) {
    text = rawContent.map((part) => part.text || '').join('');
  } else {
    text = rawContent;
  }

  let cleaned = text.trim();

  // 🔧 去掉 ```json ... ``` 這種 Markdown code fence
  if (cleaned.startsWith('```')) {
    // 去掉第一行 ```json 或 ```
    const firstNewline = cleaned.indexOf('\n');
    if (firstNewline !== -1) {
      cleaned = cleaned.slice(firstNewline + 1);
    }
    // 去掉最後一個 ```
    const lastFence = cleaned.lastIndexOf('```');
    if (lastFence !== -1) {
      cleaned = cleaned.slice(0, lastFence);
    }
    cleaned = cleaned.trim();
  }

  try {
    const json = JSON.parse(cleaned);
    return json;
  } catch (err) {
    console.error('❌ Vision JSON parse error:', err);
    console.error('🔎 model 回傳內容為：', cleaned);
    return null;
  }
}

module.exports = { parseScheduleImage };
