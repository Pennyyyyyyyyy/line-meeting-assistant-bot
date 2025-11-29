// src/visionParser.js

const fetch = require('node-fetch');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ✅ 使用您清單中最強的 Flash 模型，視覺辨識能力較好
const GEMINI_MODEL = 'gemini-2.5-flash';

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * 解析 screenshot → 回傳 busy[]
 *
 * @param {Buffer} imageBuffer
 * @param {string} userId
 * @returns {Promise<{busy: Array}>|null}
 */
async function parseScheduleImage(imageBuffer, userId = 'Unknown') {
    if (!GEMINI_API_KEY) {
        console.warn('⚠️ 尚未設定 GEMINI_API_KEY，跳過 Vision 解析。');
        return null;
    }

    const base64Image = imageBuffer.toString('base64');

    // ⭐ 針對「半小時精確度」優化的 Prompt
    const prompt = `
你是一個高精確度的課表解析 AI。請分析這張圖片，找出所有「有事情/有課」(Busy) 的時間區段。

### 關鍵任務：精確識別「30分鐘」的區間 (XX:30)

這張課表(例如政大 APP)的特徵：
1. **格線 (Grid Lines)**：背景的橫線代表整點 (例如 18:00, 19:00)。
2. **色塊位置 (Block Position)**：
   - 如果色塊的上緣或下緣**剛好壓在線上** -> 代表整點 (XX:00)。
   - 如果色塊的上緣或下緣**位於兩條線的正中間** -> 代表半點 (**XX:30**)。

### 範例分析 (請仔細看圖片)：
- 看到星期二(Tue)晚上的綠色區塊嗎？它位於 18:00 和 19:00 的線之間 -> 開始時間應為 **18:30**。
- 它結束於 21:00 和 22:00 的線之間 -> 結束時間應為 **21:30**。
- 請對所有色塊都應用這種「視覺對齊」判斷。

### 輸出規則 (Strict Rules)：
1. **Day**: Mon, Tue, Wed, Thu, Fri, Sat, Sun。
2. **Time**: 格式必須是 HH:MM (24小時制)。
   - 務必精確區分 **XX:00** 與 **XX:30**。
   - 不要自動四捨五入到整點。
3. **Ignore**: 
   - 忽略包含「停修」文字的格子。
   - 忽略空白格。
4. **Output**: 純 JSON 格式。

JSON 結構:
{
  "busy": [
    { "day": "Tue", "start": "10:00", "end": "12:00", "title": "體育" },
    { "day": "Tue", "start": "18:30", "end": "21:30", "title": "系排練習" }
  ]
}
`;

    let response;
    try {
        console.log(`[Gemini] 使用模型 ${GEMINI_MODEL} 解析圖片 (著重 30 分鐘精度)...`);
        
        response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: prompt },
                        {
                            inlineData: {
                                mimeType: 'image/jpeg',
                                data: base64Image,
                            },
                        },
                    ],
                }],
                // 設定較低的 temperature 讓 AI 專注於視覺事實，不瞎掰
                generationConfig: {
                    temperature: 0.1, 
                    topP: 0.8,
                    topK: 40
                }
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('❌ Gemini API error:', response.status, errText);
            return null;
        }
    } catch (err) {
        console.error('❌ Gemini 呼叫失敗：', err);
        return null;
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
        console.error('❌ Gemini 回傳內容為空');
        return null;
    }

    let cleanJson = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

    try {
        const parsed = JSON.parse(cleanJson);
        let busyArray = parsed.busy || [];

        if (Array.isArray(parsed)) busyArray = parsed;

        // 過濾無效資料
        busyArray = busyArray.filter(item => {
            if (!item.day || !item.start || !item.end) return false;
            if ((item.title || '').includes('停修')) return false;
            return true;
        });

        console.log(`✅ 解析完成，找到 ${busyArray.length} 個忙碌時段`);
        // Debug: 印出來確認有沒有抓到 18:30
        busyArray.forEach(b => console.log(`   📅 ${b.day} ${b.start}-${b.end} (${b.title})`));

        return { busy: busyArray };

    } catch (err) {
        console.error('❌ JSON 解析失敗:', err);
        return null;
    }
}

module.exports = { parseScheduleImage };