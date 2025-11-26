// src/scheduler.js

// 產生時間格子，例如 08:00, 08:30, 09:00, ...
// options: { startHour: 8, endHour: 24, slotMinutes: 30 }
function generateTimeSlots(options = {}) {
  const {
    startHour = 8,
    endHour = 24, // 不包含 endHour 本身
    slotMinutes = 30,
  } = options;

  const slots = [];

  for (let hour = startHour; hour < endHour; hour++) {
    for (let m = 0; m < 60; m += slotMinutes) {
      const hh = hour.toString().padStart(2, '0');
      const mm = m.toString().padStart(2, '0');
      slots.push(`${hh}:${mm}`);
    }
  }

  return slots;
}

// availabilities 是一個陣列，每一筆長這樣：
// { userId: 'Emory', status: 'available' | 'unavailable', startTime: 'HH:MM', endTime: 'HH:MM' }
// 注意：endTime 不包含在內（[startTime, endTime)）
function mergeAvailabilities(slots, availabilities) {
  const merged = {};

  // 先把每個 slot 初始化
  for (const slot of slots) {
    merged[slot] = {
      available: [],
      unavailable: [],
    };
  }

  for (const entry of availabilities) {
    const { userId, status, startTime, endTime } = entry;

    const startIndex = slots.indexOf(startTime);
    const endIndex = slots.indexOf(endTime);

    if (startIndex === -1 || endIndex === -1) {
      // 找不到對應 slot，就略過這筆
      continue;
    }

    // 從 startIndex 開始，一直到 endIndex「之前」的 slot 都套用這個狀態
    for (let i = startIndex; i < endIndex; i++) {
      const slot = slots[i];
      if (!merged[slot]) continue;

      if (status === 'available') {
        if (!merged[slot].available.includes(userId)) {
          merged[slot].available.push(userId);
        }
      } else if (status === 'unavailable') {
        if (!merged[slot].unavailable.includes(userId)) {
          merged[slot].unavailable.push(userId);
        }
      }
    }
  }

  return merged;
}

// 從 merged 結果中找出「最多人可以」的時間區段
// minDurationSlots 表示會議最少需要幾個 slot，例如 2 代表 1 小時（slot = 30 分鐘）
function findBestSlots(merged, minDurationSlots = 2) {
  const slotKeys = Object.keys(merged);
  let bestCount = 0;
  let candidates = [];

  // sliding window，長度 = minDurationSlots
  for (let i = 0; i <= slotKeys.length - minDurationSlots; i++) {
    const windowSlots = slotKeys.slice(i, i + minDurationSlots);

    // 取這幾個 slot 共同的 available 使用者（交集）
    let commonAvailable = [...merged[windowSlots[0]].available];

    for (let j = 1; j < windowSlots.length; j++) {
      const slotAvail = merged[windowSlots[j]].available;
      commonAvailable = commonAvailable.filter((u) => slotAvail.includes(u));
    }

    const count = commonAvailable.length;
    if (count === 0) continue;

    if (count > bestCount) {
      bestCount = count;
      candidates = [
        {
          slots: windowSlots, // 例如 ['14:00','14:30']
          users: commonAvailable,
        },
      ];
    } else if (count === bestCount) {
      candidates.push({
        slots: windowSlots,
        users: commonAvailable,
      });
    }
  }

  return {
    bestCount,
    candidates,
  };
}

module.exports = {
  generateTimeSlots,
  mergeAvailabilities,
  findBestSlots,
};
