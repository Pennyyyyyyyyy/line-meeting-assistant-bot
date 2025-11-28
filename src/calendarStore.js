// src/calendarStore.js

const userCalendars = new Map();

/** 儲存常用行事曆 */
function saveUserDefaultCalendar(userId, availability) {
  userCalendars.set(userId, availability);
}

/** 取得常用行事曆 */
function loadUserDefaultCalendar(userId) {
  return userCalendars.get(userId) || null;
}

module.exports = {
  saveUserDefaultCalendar,
  loadUserDefaultCalendar,
};
