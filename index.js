// index.js
require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');

// Vision：解析課表圖片
const { parseScheduleImage } = require('./src/visionParser');
const { saveUserDefaultCalendar, loadUserDefaultCalendar } = require('./src/calendarStore');

// 自然語言解析「我 18:00–20:00 有空」
const { parseAvailabilityText } = require('./src/nlpParser');

// 會議排程演算法
const {
    generateTimeSlots,
    mergeAvailabilities,
    findBestSlotsWithPartial,
} = require('./src/scheduler');

// 儲存每個聊天室／每個使用者的可用時間
const {
    setUserAvailability,
    getAllAvailabilities,
    clearAvailabilities,//清除使用者可用時間
} = require('./src/availabilityStore');

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

    app.post('/webhook', (req, res) => {
        console.warn('⚠️ 收到 /webhook 請求，但 LINE client 尚未初始化（尚未設定金鑰）。');
        res.status(200).json({ message: 'LINE client not configured yet' });
    });
}

// ===== 小工具函式們=====

// 把 LINE event.source 轉成「聊天室 ID」：群組 / 房間 / 個人
function getConversationId(source) {
    if (!source) return 'unknown';
    if (source.type === 'group') return `group:${source.groupId}`;
    if (source.type === 'room') return `room:${source.roomId}`;
    return `user:${source.userId}`;
}

// 小工具：給最後一格 slot（例如 20:30）、slotMinutes=30 → 算出結束時間（例如 21:00）
function computeEndTime(lastSlot, slotMinutes) {
    const [hh, mm] = lastSlot.split(':').map(Number);
    const totalMinutes = hh * 60 + mm + slotMinutes;
    const endHour = Math.floor(totalMinutes / 60);
    const endMin = totalMinutes % 60;
    return `${endHour.toString().padStart(2, '0')}:${endMin.toString().padStart(2, '0')}`;
}

// 如果沒有任何符合門檻的會議時間，就算出「大家錯開的最大區段」
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
        return `目前沒有可以一起開會的時間，要不要再看看其他時間，或是${dayLabel}${fallback.start}-${fallback.end} 有沒有人能把事情排開呢～`;
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
        return `建議會議時間：${dayLabel} ${start}–${end}\n全員到齊（${totalUsers}/${totalUsers} 人）`;
    }



    // ⭐ 情境 2 + 一般情況：有人部分出席 / 有人不能到
    const lines = [];
    const fullCount = full.length;
    const partialCount = partial.length;
    const canAttend = fullCount + partialCount;

    lines.push(`建議會議時間：${dayLabel} ${start}–${end}`);
    lines.push(`預計可出席：${canAttend}/${totalUsers} 人（全程：${fullCount}，部分時段：${partialCount}）`);


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

// ===== 小工具：取得顯示名稱（支援 1 對 1 / 群組 / 房間）=====
async function getDisplayNameFromSource(source) {
    if (!client || !source) return '你的';

    try {
        // 在群組或房間裡，source.userId 一樣會帶，但如果沒有就直接用 '你的'
        const userId = source.userId;
        if (!userId) return '你的';

        // 先試一般 getProfile（1 對 1 / OA）
        try {
            const profile = await client.getProfile(userId);
            if (profile && profile.displayName) {
                return profile.displayName;
            }
        } catch (e) {
            // 如果在群組有問題，可以再看要不要改成 getGroupMemberProfile / getRoomMemberProfile
            console.warn('⚠️ getProfile 失敗，改用 userId 當名稱');
            return userId;
        }

        return userId;
    } catch (err) {
        console.warn('⚠️ 取得顯示名稱失敗，fallback 成「你的」', err);
        return '你的';
    }
}

// ===== 將文字轉成星期（單一天）=====
function parseWeekdayFromText(text) {
    if (!text) return null;
    if (/星期一|週一|礼拜一|禮拜一|Monday|Mon/i.test(text)) return 'Mon';
    if (/星期二|週二|礼拜二|禮拜二|Tuesday|Tue/i.test(text)) return 'Tue';
    if (/星期三|週三|礼拜三|禮拜三|Wednesday|Wed/i.test(text)) return 'Wed';
    if (/星期四|週四|礼拜四|禮拜四|Thursday|Thu/i.test(text)) return 'Thu';
    if (/星期五|週五|礼拜五|禮拜五|Friday|Fri/i.test(text)) return 'Fri';
    if (/星期六|週六|礼拜六|禮拜六|Saturday|Sat/i.test(text)) return 'Sat';
    if (/星期日|星期天|週日|週天|礼拜天|禮拜天|Sunday|Sun/i.test(text)) return 'Sun';
    return null;
}

// ===== 多天：從文字裡抓出多個星期幾（例如「星期一、二」）=====
const WEEKDAY_MAP = {
    '一': 'Mon',
    '二': 'Tue',
    '三': 'Wed',
    '四': 'Thu',
    '五': 'Fri',
    '六': 'Sat',
    '日': 'Sun',
    '天': 'Sun',
};

// 例如：
// 「用課表填星期一、二」→ ['Mon', 'Tue']
// 「星期三四用課表」    → ['Wed', 'Thu']
// 「Mon / Wed」         → ['Mon', 'Wed']
function parseWeekdaysFromText(text) {
    if (!text) return [];

    const days = new Set();

    // 方案 A：中文「星期一、二、三」
    const m = text.match(/星期([一二三四五六日天、和及,，]+)/);
    if (m) {
        const body = m[1]; // 例如：'一、二'
        body
            .split(/[、和及,，]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .forEach((tok) => {
                const ch = tok[0]; // 取第一個字：一 / 二 / 三
                const d = WEEKDAY_MAP[ch];
                if (d) days.add(d);
            });
    }

    // 方案 B：單獨出現的「星期一」「星期四」也算
    Object.entries(WEEKDAY_MAP).forEach(([ch, d]) => {
        const re = new RegExp('星期' + ch);
        if (re.test(text)) days.add(d);
    });

    // 方案 C：英文縮寫
    if (/Mon/i.test(text)) days.add('Mon');
    if (/Tue/i.test(text)) days.add('Tue');
    if (/Wed/i.test(text)) days.add('Wed');
    if (/Thu/i.test(text)) days.add('Thu');
    if (/Fri/i.test(text)) days.add('Fri');
    if (/Sat/i.test(text)) days.add('Sat');
    if (/Sun/i.test(text)) days.add('Sun');

    return Array.from(days);
}

function timeStrToMinutes(t) {
    const [hh, mm] = t.split(':').map(Number);
    return hh * 60 + mm;
}

function minutesToTimeStr(mins) {
    const hh = Math.floor(mins / 60);
    const mm = mins % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// ===== 由課表計算 free slots =====
function computeFreeRangesFromCalendar(calendar, dayKey, options = {}) {
    if (!calendar || !Array.isArray(calendar.busy)) return [];

    const dayStart = options.dayStart || '08:00';
    const dayEnd = options.dayEnd || '22:00';

    const startMin = timeStrToMinutes(dayStart);
    const endMin = timeStrToMinutes(dayEnd);

    // 取出該天所有 busy
    const busyBlocks = calendar.busy
        .filter((b) => b.day === dayKey)
        .map((b) => ({
            start: Math.max(timeStrToMinutes(b.start), startMin),
            end: Math.min(timeStrToMinutes(b.end), endMin),
        }))
        .filter((b) => b.start < b.end)
        .sort((a, b) => a.start - b.start);

    const free = [];
    let cursor = startMin;

    busyBlocks.forEach((b) => {
        if (b.start > cursor) {
            free.push({
                status: 'available',
                startTime: minutesToTimeStr(cursor),
                endTime: minutesToTimeStr(b.start),
            });
        }
        cursor = Math.max(cursor, b.end);
    });

    if (cursor < endMin) {
        free.push({
            status: 'available',
            startTime: minutesToTimeStr(cursor),
            endTime: minutesToTimeStr(endMin),
        });
    }

    return free;
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
            // 先立刻回覆使用者，避免他以為沒反應
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: '📷 已接收課表，分析中...',
            });

            // 從 LINE 下載圖片內容
            const stream = await client.getMessageContent(event.message.id);
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            const buffer = Buffer.concat(chunks);

            const userId = event.source?.userId || 'unknown-user';

            const parsed = await parseScheduleImage(buffer, userId);

            // 決定要推播回哪個聊天室（群組 / 房間 / 個人）
            let targetId = null;
            if (event.source.type === 'group') {
                targetId = event.source.groupId;
            } else if (event.source.type === 'room') {
                targetId = event.source.roomId;
            } else {
                targetId = userId;
            }

            if (!parsed) {
                // 解析失敗，用 push 再回一則訊息
                if (targetId) {
                    await client.pushMessage(targetId, {
                        type: 'text',
                        text: '❌ 無法解析課表圖片，能否傳更清楚一點的版本？\n（或先用「我 18:00–20:00 有空」這種文字方式提供時段）',
                    });
                }
                return null;
            }

            // 存成這個使用者的常用行事曆
            saveUserDefaultCalendar(userId, parsed);

            if (targetId) {
                await client.pushMessage(targetId, {
                    type: 'text',
                    text: '📚 已成功解析課表，並儲存為你的常用行事曆！\n之後可以在群組說「用課表填星期一」或「用課表填整週」。',
                });
            }

            return null;
        } catch (err) {
            console.error('❌ 處理圖片時發生錯誤：', err);

            // 再次決定目標聊天室
            let targetId = null;
            if (event.source?.type === 'group') {
                targetId = event.source.groupId;
            } else if (event.source?.type === 'room') {
                targetId = event.source.roomId;
            } else if (event.source?.userId) {
                targetId = event.source.userId;
            }

            if (targetId) {
                await client.pushMessage(targetId, {
                    type: 'text',
                    text: '❌ 處理課表圖片時發生錯誤，請稍後再試試看，或先改用文字輸入可用時間。',
                });
            }

            return null;
        }
    }


    // ===== 文字訊息 =====
    if (event.message.type === 'text') {
        const text = event.message.text.trim();
        const conversationId = getConversationId(event.source);
        const userId = event.source?.userId;

        console.log('📩 收到文字訊息：', { text, conversationId, userId });

        // 0) 使用者詢問「其他開會時間？」：列出所有「全員到齊」的時間
        if (/其他開會時間/.test(text)) {
            const allAvail = getAllAvailabilities(conversationId);

            if (!allAvail.length) {
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '目前這個聊天室還沒有人提供可用時間，請大家先傳「我 18:00–20:00 有空」這樣的訊息喔～',
                });
            }

            const slots = generateTimeSlots({
                startHour: 8,
                endHour: 24,
                slotMinutes: 30,
            });
            const merged = mergeAvailabilities(slots, allAvail);

            const slotKeys = Object.keys(merged).sort();

            // 收集所有 userId，計算總人數
            const userSet = new Set();
            slotKeys.forEach((slot) => {
                (merged[slot].available || []).forEach((u) => userSet.add(u));
                (merged[slot].unavailable || []).forEach((u) => userSet.add(u));
            });
            const totalUsers = userSet.size;

            if (totalUsers === 0) {
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '目前還沒有任何人的可用時間喔～',
                });
            }

            // 找出所有「每一格都全員到齊」的連續區段
            const windows = [];
            let currentStart = null;
            let lastIdx = -1;

            slotKeys.forEach((slot, idx) => {
                const bucket = merged[slot];
                const fullHere =
                    (bucket.available || []).length === totalUsers &&
                    (bucket.unavailable || []).length === 0;

                if (fullHere) {
                    if (currentStart === null) {
                        currentStart = slot;
                        lastIdx = idx;
                    } else if (idx === lastIdx + 1) {
                        lastIdx = idx;
                    } else {
                        // 斷開 → 把前一段收起來
                        const endTime = computeEndTime(slotKeys[lastIdx], 30);
                        windows.push({ start: currentStart, end: endTime });
                        currentStart = slot;
                        lastIdx = idx;
                    }
                } else {
                    if (currentStart !== null) {
                        const endTime = computeEndTime(slotKeys[lastIdx], 30);
                        windows.push({ start: currentStart, end: endTime });
                        currentStart = null;
                        lastIdx = -1;
                    }
                }
            });

            // 收尾
            if (currentStart !== null) {
                const endTime = computeEndTime(slotKeys[lastIdx], 30);
                windows.push({ start: currentStart, end: endTime });
            }

            if (!windows.length) {
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '目前沒有任何「全員到齊」的時間，可以試試輸入「人沒全到也沒關係」看看其它可行時段。',
                });
            }

            const lines = windows.map((w, i) => `${i + 1}. ${w.start}–${w.end}`);

            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: `以下是所有「全員到齊」的可開會時間（套用目前這個聊天室的成員）：\n${lines.join(
                    '\n',
                )}`,
            });
        }

        // 0.5) 使用者說「人沒全到也沒關係」：列出所有符合人數門檻規則的時間（每格 30 分鐘）
        if (/人沒全到也沒關係/.test(text)) {
            const allAvail = getAllAvailabilities(conversationId);

            if (!allAvail.length) {
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '目前這個聊天室還沒有人提供可用時間，請大家先傳「我 18:00–20:00 有空」這樣的訊息喔～',
                });
            }

            const slots = generateTimeSlots({
                startHour: 8,
                endHour: 24,
                slotMinutes: 30,
            });
            const merged = mergeAvailabilities(slots, allAvail);
            const slotKeys = Object.keys(merged).sort();

            // 收集所有 userId
            const userSet = new Set();
            slotKeys.forEach((slot) => {
                (merged[slot].available || []).forEach((u) => userSet.add(u));
                (merged[slot].unavailable || []).forEach((u) => userSet.add(u));
            });
            const allUsers = Array.from(userSet);
            const totalUsers = allUsers.length;

            if (totalUsers === 0) {
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '目前還沒有任何人的可用時間喔～',
                });
            }

            // 依照你原本 scheduler 的人數門檻規則
            function passesThreshold(totalCanAttend, unavailableCount) {
                if (totalUsers <= 3) {
                    // 3 人以下要全到
                    return unavailableCount === 0;
                }
                if (totalUsers >= 4 && totalUsers <= 8) {
                    // 4–8：最多 2 人不能到
                    return unavailableCount <= 2 && totalCanAttend >= totalUsers - 2;
                }
                if (totalUsers >= 9 && totalUsers <= 11) {
                    // 9–11：最多 3 人不能到
                    return unavailableCount <= 3 && totalCanAttend >= totalUsers - 3;
                }
                // 12 人以上，只要過半數
                return totalCanAttend >= Math.ceil(totalUsers / 2);
            }

            const candidates = [];

            // 這裡先簡單：每一格 30 分鐘當作一個可能的會議時間
            slotKeys.forEach((slot) => {
                const windowSlots = [slot];

                const fullAvailable = [];
                const partialAvailable = [];
                const unavailable = [];

                allUsers.forEach((userId) => {
                    let hasAvailable = 0;
                    let hasUnavailable = false;

                    windowSlots.forEach((s) => {
                        const bucket = merged[s];
                        if ((bucket.unavailable || []).includes(userId)) {
                            hasUnavailable = true;
                        }
                        if ((bucket.available || []).includes(userId)) {
                            hasAvailable++;
                        }
                    });

                    if (hasUnavailable) {
                        unavailable.push(userId);
                    } else if (hasAvailable === windowSlots.length) {
                        fullAvailable.push(userId);
                    } else if (hasAvailable > 0) {
                        partialAvailable.push(userId);
                    } else {
                        unavailable.push(userId);
                    }
                });

                const totalCanAttend = fullAvailable.length + partialAvailable.length;
                const unavailableCount = unavailable.length;

                if (!passesThreshold(totalCanAttend, unavailableCount)) return;

                candidates.push({
                    start: slot,
                    end: computeEndTime(slot, 30),
                    fullAvailable,
                    partialAvailable,
                    unavailable,
                    totalCanAttend,
                });
            });

            if (!candidates.length) {
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '依照你設定的人數門檻，目前找不到可以開會的時間 😢',
                });
            }

            const lines = candidates.map((c, idx) => {
                const fullCount = c.fullAvailable.length;
                const partialCount = c.partialAvailable.length;
                const canAttend = c.totalCanAttend;
                return `${idx + 1}. ${c.start}–${c.end}：可出席 ${canAttend}/${totalUsers} 人（全程：${fullCount}，部分：${partialCount}）`;
            });

            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: `以下是所有符合人數門檻規則的可開會時間（每格 30 分鐘）：\n${lines.join('\n')}`,
            });
        }



        // 1) 使用者詢問「開會時間？」（預設優先找 18:00 以後的時段）
        if (/開會時間/.test(text)) {
            const allAvail = getAllAvailabilities(conversationId);

            if (!allAvail.length) {
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '目前這個聊天室還沒有人提供可用時間，請大家先傳「我 18:00–20:00 有空」這樣的訊息喔～',
                });
            }

            // 先從 18:00 後開始找（晚上優先）
            const eveningSlots = generateTimeSlots({
                startHour: 18,
                endHour: 24,
                slotMinutes: 30,
            });
            const mergedEvening = mergeAvailabilities(eveningSlots, allAvail);
            const eveningResult = findBestSlotsWithPartial(mergedEvening, 1);

            let messageText;

            if (
                eveningResult &&
                Array.isArray(eveningResult.candidates) &&
                eveningResult.candidates.length > 0 &&
                eveningResult.bestTotalCanAttend > 0
            ) {
                // 有找到晚上可以開會的 → 用晚上結果
                messageText = formatMeetingSuggestion(eveningResult, mergedEvening, '那天（晚上優先）', 30);
            } else {
                // 晚上完全不行 → 改用整天 08:00–24:00 去找
                const slots = generateTimeSlots({
                    startHour: 8,
                    endHour: 24,
                    slotMinutes: 30,
                });
                const merged = mergeAvailabilities(slots, allAvail);
                const result = findBestSlotsWithPartial(merged, 1); // 1 格 = 30 分鐘

                messageText = formatMeetingSuggestion(result, merged, '那天', 30);
            }

            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: messageText,
            });
        }


        // 2) 用課表填星期X / 多天 / 整週
        const isWholeWeek = /整週|全週|整周|全周/.test(text);
        let weekdayList = parseWeekdaysFromText(text);

        // 如果沒抓到多天，但可以解析出單一天，當作單一天使用
        if (!weekdayList.length) {
            const single = parseWeekdayFromText(text);
            if (single) weekdayList = [single];
        }

        if ((isWholeWeek || weekdayList.length > 0) && conversationId && userId) {
            const calendar = loadUserDefaultCalendar(userId);

            if (!calendar) {
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '你還沒有上傳課表喔～請私訊我一張你的課表截圖，我會自動幫你解析。',
                });
            }

            // 🔹決定要套用哪幾天
            let targetDays;
            if (isWholeWeek) {
                // 整週：以課表裡實際出現過的 day 為主
                const set = new Set(
                    (calendar.busy || [])
                        .map((b) => b.day)
                        .filter(Boolean),
                );
                // 如果課表裡沒有 day，就預設 Mon–Fri
                if (set.size === 0) {
                    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].forEach((d) => set.add(d));
                }
                targetDays = Array.from(set);
            } else {
                targetDays = weekdayList;
            }

            if (!targetDays.length) {
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '好像看不出要用哪幾天的課表，可以試試說「用課表填星期二」或「用課表填整週」唷～',
                });
            }

            // 🔹從課表計算每一天的 free slots，全部合併起來寫進 availability
            const allFreeRanges = [];
            targetDays.forEach((dayKey) => {
                const free = computeFreeRangesFromCalendar(calendar, dayKey, {
                    dayStart: '08:00',
                    dayEnd: '22:00',
                });
                free.forEach((r) => {
                    allFreeRanges.push({ day: dayKey, ...r });
                });
            });

            if (!allFreeRanges.length) {
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '根據你的課表，這些天看起來都排滿了，沒有明顯的空檔可以開會 😅',
                });
            }

            // 轉成 availabilityStore 用的格式
            // （目前 scheduler 沒有處理星期，所以這裡只存時間，不存 day）
            const availabilityEntries = allFreeRanges.map((r) => ({
                userId,
                status: r.status,       // 'available'
                startTime: r.startTime,
                endTime: r.endTime,
            }));

            setUserAvailability(conversationId, userId, availabilityEntries);

            // 人類看的 summary
            const dayLabelMap = {
                Mon: '星期一',
                Tue: '星期二',
                Wed: '星期三',
                Thu: '星期四',
                Fri: '星期五',
                Sat: '星期六',
                Sun: '星期日',
            };

            const lines = [];
            targetDays.forEach((dayKey) => {
                const ranges = allFreeRanges.filter((r) => r.day === dayKey);
                if (!ranges.length) return;
                const segs = ranges
                    .map((r) => `${r.startTime}–${r.endTime}`)
                    .join('、');
                lines.push(`${dayLabelMap[dayKey] || dayKey}：${segs}`);
            });

            // 取得使用者名稱，讓回覆變成「xxx的課表」
            const displayName = await getDisplayNameFromSource(event.source);
            const namePrefix =
                displayName === userId ? '你的' : `${displayName} 的`;

            const headerText = isWholeWeek
                ? `已根據${namePrefix}課表，套用整週的有空時間：`
                : `已根據${namePrefix}課表，套用這幾天的有空時間：`;

            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: `${headerText}\n${lines.join('\n')}\n\n之後大家在這個聊天室輸入「開會時間？」，我就會把這些時段一起算進去（目前先當成是「某一天」的時間區段使用）。`,
            });

        }

        // 3) 嘗試把訊息當成「我 18:00–20:00 有空 / 不行」
        const parsedAvail = parseAvailabilityText(text);
        if (parsedAvail && conversationId && userId) {
            setUserAvailability(conversationId, userId, [parsedAvail]);

            const statusText =
                parsedAvail.status === 'available' ? '有空' : '不行';

            // ⭐ 這裡改成用顯示名稱
            const displayName = await getDisplayNameFromSource(event.source);

            // 如果拿到的剛好是 userId（一坨亂碼），就用「你的」
            const nameToDisplay =
                displayName === userId ? '你的' : `${displayName} 的`;

            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: `${nameToDisplay}時間已更新：${parsedAvail.startTime}–${parsedAvail.endTime}（${statusText}）。\n之後在這個聊天室輸入「開會時間？」，我會幫大家排一個時段。`,
            });
        }

        // 4) 其他文字：先維持 echo 行為
        const replyText = `你說了：「${text}」`;

        return client.replyMessage(event.replyToken, {
            type: 'text',
            text: replyText,
        });
    }

    // 其他型態先忽略
    return Promise.resolve(null);
}

// const replyText = `你說：${text}嗎？好的，請稍等`;
// return client.replyMessage(event.replyToken, {
//     type: 'text',
//     text: replyText,

// 簡單 health check，讓你不用 LINE 也可以確認伺服器有跑起來
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`🚀 Server is running on port ${port}`);
});
