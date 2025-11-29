// src/nlpParser.js

// 把「我 18:00–20:00 有空」、「我 19-21 不行」這種句子，轉成時間區間＋狀態
// 目前簡單支援：數字時間 + 有空 / 不行 / 沒空
// 回傳：{ status: 'available' | 'unavailable', startTime: 'HH:MM', endTime: 'HH:MM' } 或 null

function toTime(hStr, mStr) {
  let h = parseInt(hStr, 10);
  if (Number.isNaN(h)) return null;
  if (h < 0) h = 0;
  if (h > 23) h = 23;

  let m = mStr != null ? parseInt(mStr, 10) : 0;
  if (Number.isNaN(m)) m = 0;
  if (m < 0) m = 0;
  if (m > 59) m = 59;

  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseAvailabilityText(text) {
  if (!text) return null;

  // 判斷是「有空」還是「不行/沒空」
  let status = null;
  if (/(不行|沒空|没空|不可以|不方便)/.test(text)) {
    status = 'unavailable';
  } else if (/(有空|可以|ok|OK|ＯＫ|方便)/.test(text)) {
    status = 'available';
  }

  if (!status) {
    return null; // 沒看出來是有空或沒空，就先當作不是可用時間訊息
  }

  // 抓時間區間：18:00–20:30、18-21、18：30 到 21：00 都可以
  const rangeRegex =
    /(\d{1,2})(?:[:：](\d{2}))?\s*[~～\-–—到至]\s*(\d{1,2})(?:[:：](\d{2}))?/;
  const m = text.match(rangeRegex);

  if (!m) {
    return null; // 沒有時間區間，不處理
  }

  const start = toTime(m[1], m[2]);
  const end = toTime(m[3], m[4]);

  if (!start || !end) return null;

  return {
    status,
    startTime: start,
    endTime: end,
  };
}

module.exports = {
  parseAvailabilityText,
};
