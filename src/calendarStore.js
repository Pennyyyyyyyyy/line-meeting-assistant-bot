// src/calendarStore.js

// ⭐ 使用 Map 儲存每個使用者的常用課表
const userCalendars = new Map();

/** 儲存常用行事曆（課表） */
function saveUserDefaultCalendar(userId, calendar) {
  userCalendars.set(userId, calendar);
}

/** 讀取常用行事曆（課表） */
function loadUserDefaultCalendar(userId) {
  return userCalendars.get(userId) || null;
}

module.exports = {
  saveUserDefaultCalendar,
  loadUserDefaultCalendar,
};
