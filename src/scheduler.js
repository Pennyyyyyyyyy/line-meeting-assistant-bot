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

// 原本的版本：只算「全程都在場的人」的交集
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

// ===== 新增：考慮「部分出席」的版本 =====

// 統計一個會議 window（例如 ['20:00','20:30']）內
// 每個 user 是「全程有空 / 部分有空 / 完全沒空」
function analyzeWindowForUsers(merged, windowSlots, allUserIds) {
  const fullAvailable = [];
  const partialAvailable = [];
  const unavailable = [];

  for (const userId of allUserIds) {
    let countAvailable = 0;

    for (const slot of windowSlots) {
      const slotAvail = merged[slot]?.available || [];
      if (slotAvail.includes(userId)) {
        countAvailable++;
      }
    }

    if (countAvailable === windowSlots.length) {
      // 每一格都有空 → 全程可參加
      fullAvailable.push(userId);
    } else if (countAvailable > 0) {
      // 至少一格有空，但不是全部 → 部分可參加（例如要提早走）
      partialAvailable.push(userId);
    } else {
      // 完全沒有重疊 → 這段時間都不能來
      unavailable.push(userId);
    }
  }

  return {
    fullAvailable,
    partialAvailable,
    unavailable,
  };
}

// 新版本：
// - 目標：找「總共能出現的人」最多的時間（全程 + 部分）
// - 同分時優先「全程可參加的人」比較多的 window
function findBestSlotsWithPartial(merged, minDurationSlots = 2) {
  const slotKeys = Object.keys(merged);

  // 找出所有出現過的 userId（不管是 available / unavailable）
  const userSet = new Set();
  for (const slot of slotKeys) {
    for (const u of merged[slot].available) {
      userSet.add(u);
    }
    for (const u of merged[slot].unavailable) {
      userSet.add(u);
    }
  }
  const allUserIds = Array.from(userSet);

  // ⭐ 至少要幾個人能參加，才算是一個「合理的會議」？
  const MIN_PARTICIPANTS = 2;

  let bestTotalCanAttend = 0; // 全程 + 部分 的人數
  let bestFullCount = 0; // 全程可參加的人數（當作次要排序）
  let candidates = [];

  for (let i = 0; i <= slotKeys.length - minDurationSlots; i++) {
    const windowSlots = slotKeys.slice(i, i + minDurationSlots);

    const stats = analyzeWindowForUsers(merged, windowSlots, allUserIds);
    const totalCanAttend = stats.fullAvailable.length + stats.partialAvailable.length;

    // ⭐ 只有 0 或 1 個人能來，一律忽略，不當成候選
    if (totalCanAttend < MIN_PARTICIPANTS) continue;

    if (
      totalCanAttend > bestTotalCanAttend ||
      (totalCanAttend === bestTotalCanAttend &&
        stats.fullAvailable.length > bestFullCount)
    ) {
      bestTotalCanAttend = totalCanAttend;
      bestFullCount = stats.fullAvailable.length;
      candidates = [
        {
          slots: windowSlots,
          ...stats,
        },
      ];
    } else if (
      totalCanAttend === bestTotalCanAttend &&
      stats.fullAvailable.length === bestFullCount
    ) {
      candidates.push({
        slots: windowSlots,
        ...stats,
      });
    }
  }

  return {
    bestTotalCanAttend,
    bestFullCount,
    candidates,
  };
}

// 根據總人數，決定「這個會議至少要幾個人能來」才算可以開
function getRequiredParticipants(totalUsers) {
  if (totalUsers <= 3) {
    // 3 人以下要全到
    return totalUsers;
  }
  if (totalUsers <= 8) {
    // 4~8 人最多 2 個人不到
    return totalUsers - 2;
  }
  if (totalUsers <= 11) {
    // 9~11 人最多 3 個人不到
    return totalUsers - 3;
  }
  // 12 人以上，只要過半數
  return Math.ceil(totalUsers / 2);
}


module.exports = {
  generateTimeSlots,
  mergeAvailabilities,
  findBestSlots,
  findBestSlotsWithPartial,
};
