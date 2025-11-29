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

function timeToMinutes(t) {
  const [hh, mm] = t.split(':').map(Number);
  return hh * 60 + mm;
}

/**
 * 把 { userId, status, startTime, endTime } 陣列合併到 slots 上
 * merged[slot] = { available: [...], unavailable: [...] }
 *
 * 規則：
 * - available：代表這格可以參加
 * - unavailable：代表這格不能參加（會覆蓋 available）
 */
function mergeAvailabilities(slots, availabilities) {
  const merged = {};

  slots.forEach((slot) => {
    merged[slot] = {
      available: [],
      unavailable: [],
    };
  });

  availabilities.forEach((entry) => {
    const { userId, status, startTime, endTime } = entry || {};
    if (!userId || !startTime || !endTime) return;

    const startMin = timeToMinutes(startTime);
    const endMin = timeToMinutes(endTime);
    slots.forEach((slot, idx) => {
      const slotMin = timeToMinutes(slot);
      const nextSlot =
        idx + 1 < slots.length ? slots[idx + 1] : null;
      const nextMin = nextSlot ? timeToMinutes(nextSlot) : slotMin + 30;

      // slot 覆蓋區間 [slotMin, nextMin)，entry 覆蓋 [startMin, endMin)
      const overlap =
        Math.max(slotMin, startMin) < Math.min(nextMin, endMin);
      if (!overlap) return;

      const bucket = merged[slot];

      if (status === 'available') {
        // 如果已經被標示為 unavailable，就不要再設 available 了
        if (bucket.unavailable.includes(userId)) return;
        if (!bucket.available.includes(userId)) {
          bucket.available.push(userId);
        }
      } else if (status === 'unavailable') {
        // unavailable 會覆蓋 available
        if (!bucket.unavailable.includes(userId)) {
          bucket.unavailable.push(userId);
        }
        const idxAvail = bucket.available.indexOf(userId);
        if (idxAvail !== -1) {
          bucket.available.splice(idxAvail, 1);
        }
      }
    });
  });

  return merged;
}



/**
 * 找出最佳會議時間區段
 *
 * 輸入：
 *   merged: { "18:00": { available: [...], unavailable: [...] }, ... }
 *   minContinuousSlots: 至少要連續幾格（1 格 = 30 分鐘）
 *
 * 回傳：
 * {
 *   bestTotalCanAttend,
 *   bestSlotsCount,
 *   candidates: [{
 *     slots: [...],
 *     fullAvailable: [...],
 *     partialAvailable: [...],
 *     unavailable: [...],
 *   }],
 *   totalUsers,
 * }
 */
function findBestSlotsWithPartial(merged, minContinuousSlots) {
  const slotKeys = Object.keys(merged).sort(); // "HH:MM"

  // 收集所有出現過的 userId
  const userSet = new Set();
  slotKeys.forEach((slot) => {
    const bucket = merged[slot];
    (bucket.available || []).forEach((u) => userSet.add(u));
    (bucket.unavailable || []).forEach((u) => userSet.add(u));
  });
  const allUsers = Array.from(userSet);
  const totalUsers = allUsers.length;

  if (totalUsers === 0) {
    return {
      bestTotalCanAttend: 0,
      bestSlotsCount: 0,
      candidates: [],
      totalUsers: 0,
    };
  }

  // ⭐ 新增：紀錄哪些人有「明確有空」的時段
  const userHasExplicitAvailable = {};
  allUsers.forEach((u) => {
    userHasExplicitAvailable[u] = false;
  });
  slotKeys.forEach((slot) => {
    const bucket = merged[slot];
    (bucket.available || []).forEach((u) => {
      userHasExplicitAvailable[u] = true;
    });
  });

  let bestTotalCanAttend = 0;
  let bestSlotsCount = 0;
  let candidates = [];

  // 掃描所有連續 window
  for (let startIdx = 0; startIdx < slotKeys.length; startIdx++) {
    for (
      let endIdx = startIdx + minContinuousSlots - 1;
      endIdx < slotKeys.length;
      endIdx++
    ) {
      const windowSlots = slotKeys.slice(startIdx, endIdx + 1);
      const windowLen = windowSlots.length;

      const fullAvailable = [];
      const partialAvailable = [];
      const unavailable = [];

      allUsers.forEach((userId) => {
        let hasAvailable = 0;
        let hasUnavailable = false;

        for (const slot of windowSlots) {
          const bucket = merged[slot];
          if ((bucket.unavailable || []).includes(userId)) {
            hasUnavailable = true;
            break;
          }
          if ((bucket.available || []).includes(userId)) {
            hasAvailable++;
          }
        }

        if (hasUnavailable) {
          // 有任何一格不能來 → 這段會議時間視為不能來
          unavailable.push(userId);
        } else if (hasAvailable === windowLen) {
          // 每一格都有 available → 全程有空
          fullAvailable.push(userId);
        } else if (hasAvailable > 0) {
          // 部分有 available → 部分出席
          partialAvailable.push(userId);
        } else {
          // ⭐ 完全沒有資訊
          if (!userHasExplicitAvailable[userId]) {
            // 這個人從來沒有「明確有空」紀錄 → 代表只標「不行」時段
            // 在這個 window 裡又沒有「不行」，就當成「全程有空」
            fullAvailable.push(userId);
          } else {
            // 有標「有空」但這段完全不在範圍內 → 視為不能來
            unavailable.push(userId);
          }
        }
      });

      const totalCanAttend =
        fullAvailable.length + partialAvailable.length;
      const unavailableCount = unavailable.length;

      // ——— 人數門檻規則 ———
      let isValid = false;
      if (totalUsers <= 3) {
        // 3 人以下：要全員到齊（全程）
        isValid = fullAvailable.length === totalUsers;
      } else if (totalUsers >= 4 && totalUsers <= 8) {
        // 4–8：最多 2 人不能到
        isValid = unavailableCount <= 2 && totalCanAttend >= totalUsers - 2;
      } else if (totalUsers >= 9 && totalUsers <= 11) {
        // 9–11：最多 3 人不能到
        isValid = unavailableCount <= 3 && totalCanAttend >= totalUsers - 3;
      } else {
        // 12 人以上：只要過半數可以
        isValid = totalCanAttend >= Math.ceil(totalUsers / 2);
      }
      if (!isValid) continue;

      if (
        totalCanAttend > bestTotalCanAttend ||
        (totalCanAttend === bestTotalCanAttend &&
          windowLen > bestSlotsCount)
      ) {
        bestTotalCanAttend = totalCanAttend;
        bestSlotsCount = windowLen;
        candidates = [
          {
            slots: windowSlots,
            fullAvailable,
            partialAvailable,
            unavailable,
          },
        ];
      }
    }
  }

  return {
    bestTotalCanAttend,
    bestSlotsCount,
    candidates,
    totalUsers,
  };
}
  
module.exports = {
  generateTimeSlots,
  mergeAvailabilities,
  findBestSlotsWithPartial,
};

    

  

// // ===== 新增：考慮「部分出席」的版本 =====

// // 統計一個會議 window（例如 ['20:00','20:30']）內
// // 每個 user 是「全程有空 / 部分有空 / 完全沒空」
// function analyzeWindowForUsers(merged, windowSlots, allUserIds) {
//   const fullAvailable = [];
//   const partialAvailable = [];
//   const unavailable = [];

//   for (const userId of allUserIds) {
//     let countAvailable = 0;

//     for (const slot of windowSlots) {
//       const slotAvail = merged[slot]?.available || [];
//       if (slotAvail.includes(userId)) {
//         countAvailable++;
//       }
//     }

//     if (countAvailable === windowSlots.length) {
//       // 每一格都有空 → 全程可參加
//       fullAvailable.push(userId);
//     } else if (countAvailable > 0) {
//       // 至少一格有空，但不是全部 → 部分可參加（例如要提早走）
//       partialAvailable.push(userId);
//     } else {
//       // 完全沒有重疊 → 這段時間都不能來
//       unavailable.push(userId);
//     }
//   }

//   return {
//     fullAvailable,
//     partialAvailable,
//     unavailable,
//   };
// }

// // 新版本：
// // - 目標：找「總共能出現的人」最多的時間（全程 + 部分）
// // - 同分時優先「全程可參加的人」比較多的 window
// // 新版本：
// // - 目標：找「總共能出現的人」最多的時間（全程 + 部分）
// // - 只接受「達到人數門檻」的時間窗
// // - 同分時優先「全程可參加的人」比較多的 window
// function findBestSlotsWithPartial(merged, minDurationSlots = 2) {
//   const slotKeys = Object.keys(merged);

//   // 找出所有出現過的 userId（不管是 available / unavailable）
//   const userSet = new Set();
//   for (const slot of slotKeys) {
//     for (const u of merged[slot].available) {
//       userSet.add(u);
//     }
//     for (const u of merged[slot].unavailable) {
//       userSet.add(u);
//     }
//   }
//   const allUserIds = Array.from(userSet);
//   const totalUsers = allUserIds.length;

//   const required = getRequiredParticipants(totalUsers); // ⭐ 套用你定的門檻

//   let bestTotalCanAttend = 0; // 全程 + 部分 的人數
//   let bestFullCount = 0;      // 全程可參加的人數（當作次要排序）
//   let candidates = [];

//   for (let i = 0; i <= slotKeys.length - minDurationSlots; i++) {
//     const windowSlots = slotKeys.slice(i, i + minDurationSlots);

//     const stats = analyzeWindowForUsers(merged, windowSlots, allUserIds);
//     const totalCanAttend = stats.fullAvailable.length + stats.partialAvailable.length;

//     // ⭐ 沒過人數門檻就直接略過（例如只有 1 個人可以、或少於過半數）
//     if (totalCanAttend < required) continue;

//     if (
//       totalCanAttend > bestTotalCanAttend ||
//       (totalCanAttend === bestTotalCanAttend &&
//         stats.fullAvailable.length > bestFullCount)
//     ) {
//       bestTotalCanAttend = totalCanAttend;
//       bestFullCount = stats.fullAvailable.length;
//       candidates = [
//         {
//           slots: windowSlots,
//           ...stats,
//         },
//       ];
//     } else if (
//       totalCanAttend === bestTotalCanAttend &&
//       stats.fullAvailable.length === bestFullCount
//     ) {
//       candidates.push({
//         slots: windowSlots,
//         ...stats,
//       });
//     }
//   }

//   return {
//     bestTotalCanAttend,
//     bestFullCount,
//     candidates,
//     totalUsers,
//     allUserIds,
//   };
// }


// // 根據總人數，決定「這個會議至少要幾個人能來」才算可以開
// function getRequiredParticipants(totalUsers) {
//   if (totalUsers <= 3) {
//     // 3 人以下要全到
//     return totalUsers;
//   }
//   if (totalUsers <= 8) {
//     // 4~8 人最多 2 個人不到
//     return totalUsers - 2;
//   }
//   if (totalUsers <= 11) {
//     // 9~11 人最多 3 個人不到
//     return totalUsers - 3;
//   }
//   // 12 人以上，只要過半數
//   return Math.ceil(totalUsers / 2);
// }


// module.exports = {
//   generateTimeSlots,
//   mergeAvailabilities,
//   findBestSlots,
//   findBestSlotsWithPartial,
// };
