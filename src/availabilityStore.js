// src/availabilityStore.js

// 結構：conversationId -> (userId -> availabilityArray)
// availabilityArray 裡面每一筆：{ status, startTime, endTime }
// status: 'available' | 'unavailable'
const conversationMap = new Map();

/**
 * 將 "HH:MM" 轉成分鐘數
 */
function timeStrToMinutes(t) {
  const [hh, mm] = t.split(':').map(Number);
  return hh * 60 + mm;
}

/**
 * 將分鐘數轉回 "HH:MM"
 */
function minutesToTimeStr(mins) {
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * 把「一個新的區間」疊加到某個 user 原本的區間上
 *
 * 規則：
 * - 先把舊資料裡和 [start,end) 有重疊的部份切掉
 * - 再把 [start,end) 以新 status 插進去
 * - 最後做一次排序＆合併（相鄰且同 status 的區段會合併）
 *
 * 這樣就可以做到：
 *   先：20:00–22:00 available
 *   再：20:00–20:30 unavailable
 *   ⇒ 20:00–20:30 unavailable, 20:30–22:00 available
 */
function upsertInterval(existingEntries, newEntry) {
  const { status, startTime, endTime } = newEntry || {};
  if (!status || !startTime || !endTime) return existingEntries;

  let ns = timeStrToMinutes(startTime);
  let ne = timeStrToMinutes(endTime);
  if (Number.isNaN(ns) || Number.isNaN(ne) || ns >= ne) {
    return existingEntries;
  }

  const result = [];

  // 1) 先保留「與新區間不重疊」的部分，對有重疊的區段做切割
  for (const ent of existingEntries) {
    const es = timeStrToMinutes(ent.startTime);
    const ee = timeStrToMinutes(ent.endTime);

    // 完全在左邊或右邊 → 不重疊，原樣保留
    if (ee <= ns || es >= ne) {
      result.push(ent);
      continue;
    }

    // 有重疊 → 可能切成左段 / 右段
    // 左段： [es, ns)
    if (es < ns) {
      result.push({
        status: ent.status,
        startTime: ent.startTime,
        endTime: minutesToTimeStr(ns),
      });
    }

    // 右段： [ne, ee)
    if (ee > ne) {
      result.push({
        status: ent.status,
        startTime: minutesToTimeStr(ne),
        endTime: ent.endTime,
      });
    }
    // 中間那段 [max(es,ns), min(ee,ne)) 會被新的區段覆蓋，不需要保留
  }

  // 2) 把新的區段加進來
  result.push({
    status,
    startTime,
    endTime,
  });

  // 3) 依時間排序，並合併相鄰且 status 相同的區段
  result.sort((a, b) => timeStrToMinutes(a.startTime) - timeStrToMinutes(b.startTime));

  const merged = [];
  for (const ent of result) {
    if (!merged.length) {
      merged.push({ ...ent });
      continue;
    }
    const last = merged[merged.length - 1];
    const lastEnd = timeStrToMinutes(last.endTime);
    const curStart = timeStrToMinutes(ent.startTime);

    // 如果剛好接在一起（例如 20:00–20:30 跟 20:30–21:00）
    // 且 status 一樣，就合併
    if (last.status === ent.status && lastEnd >= curStart) {
      // 若有重疊或相連，以較晚的 endTime 為準
      const lastEndMin = lastEnd;
      const curEndMin = timeStrToMinutes(ent.endTime);
      if (curEndMin > lastEndMin) {
        last.endTime = ent.endTime;
      }
    } else {
      merged.push({ ...ent });
    }
  }

  return merged;
}

/**
 * 設定某個聊天室、某個使用者的可用時間
 *
 * - 和你原來的版本一樣，仍然是「疊加」概念
 * - 不同點在於：會先和舊資料比對，把重疊的區段切乾淨再覆蓋
 *   （所以新的區段會正確覆蓋舊的狀態）
 *
 * availabilityEntries 可以是：
 *   { status, startTime, endTime }
 *   或 [{...}, {...}, ...]
 */
function setUserAvailability(conversationId, userId, availabilityEntries) {
  if (!conversationId || !userId) return;

  let userMap = conversationMap.get(conversationId);
  if (!userMap) {
    userMap = new Map();
    conversationMap.set(conversationId, userMap);
  }

  const incomingArray = Array.isArray(availabilityEntries)
    ? availabilityEntries
    : [availabilityEntries];

  const existing = userMap.get(userId) || [];
  let updated = existing;

  for (const raw of incomingArray) {
    if (!raw) continue;
    const entry = {
      status: raw.status,
      startTime: raw.startTime,
      endTime: raw.endTime,
    };
    updated = upsertInterval(updated, entry);
  }

  userMap.set(userId, updated);
}

/**
 * 取得某個聊天室裡所有人的可用/不可用區段，攤平成一個陣列
 * 回傳：[{ userId, status, startTime, endTime }, ...]
 */
function getAllAvailabilities(conversationId) {
  const userMap = conversationMap.get(conversationId);
  if (!userMap) return [];

  const result = [];
  for (const [userId, entries] of userMap.entries()) {
    for (const entry of entries) {
      result.push({
        userId,
        status: entry.status,
        startTime: entry.startTime,
        endTime: entry.endTime,
      });
    }
  }
  return result;
}

/**
 * 清掉某個聊天室的所有記錄（如果之後想做「重設」指令可以用）
 * 目前維持你的原本行為：給 conversationId → 整個聊天室清空
 */
function clearAvailabilities(conversationId) {
  conversationMap.delete(conversationId);
}

module.exports = {
  setUserAvailability,
  getAllAvailabilities,
  clearAvailabilities,
};
