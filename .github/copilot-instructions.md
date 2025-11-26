# LINE Meeting Assistant Bot - AI Coding Instructions

## Project Overview
This is a LINE group bot that helps student teams find meeting times (inspired by When2Meet). It collects availability via text or images, merges time slots, and suggests optimal meeting times. The bot is designed with graceful degradation - it runs even without LINE credentials for local testing.

## Architecture & File Layout

### `index.js` - Entry Point
- Starts Express server and wires up LINE webhook
- **Graceful initialization**: Checks `CHANNEL_SECRET` and `CHANNEL_ACCESS_TOKEN` before creating LINE client
  - With credentials: Real webhook handler using `line.middleware(config)` + `handleEvent()`
  - Without credentials: Stub handler that logs warnings but keeps server running
- Endpoints:
  - `POST /webhook` - LINE message events
  - `GET /health` - Health check (`{"status":"ok"}`)
- `handleEvent(event)` - Main hook for LINE message routing and business logic

### `src/scheduler.js` - Pure Business Logic
Contains **zero HTTP/LINE dependencies** for testability:
- `generateTimeSlots({ startHour, endHour, slotMinutes })`  
  Produces `["08:00", "08:30", ...]` from startHour (inclusive) to endHour (exclusive)
- `mergeAvailabilities(slots, availabilities)`  
  Takes slots and availability objects:
  ```js
  { userId, status: 'available'|'unavailable', startTime: 'HH:MM', endTime: 'HH:MM' }
  ```
  Interprets intervals as `[startTime, endTime)` (end is **exclusive**)  
  Returns: `{ [slot]: { available: [], unavailable: [] } }`
- `findBestSlots(merged, minDurationSlots)`  
  Sliding window algorithm to find time ranges with maximum common availability  
  Returns: `{ bestCount, candidates: [{ slots: [], users: [] }] }`

### `__tests__/scheduler.test.js` - Test Suite
Jest tests validating slot generation, availability merging, and best-slot selection. When adding new core logic, put it in `src/` and test in `__tests__/`.

## Development Workflows

### Environment Variables
Defined in `.env` (see `.env.example`):
- `CHANNEL_SECRET` / `CHANNEL_ACCESS_TOKEN` - LINE API credentials
- `OPENAI_API_KEY` - For AI vision parsing (Feature 2)
- `PORT` - Server port (defaults to 3000)

Missing credentials? App still starts with `/health` working and `/webhook` logging warnings.

### Commands
```bash
npm start  # Run server (http://localhost:3000/health to verify)
npm test   # Run Jest test suite
```

### Testing With LINE
1. Set credentials in `.env`
2. `ngrok http 3000` to expose localhost
3. Configure LINE webhook: `https://<ngrok-url>/webhook`

## Critical Conventions

### Module System
**CommonJS only** - no ESM:
```javascript
module.exports = { ... }  // Export
const x = require('./path')  // Import
```

### Time Representation
- **Format**: `"HH:MM"` 24-hour strings (`"04:00"`, `"18:30"`, `"23:00"`)
- **Intervals**: `[startTime, endTime)` - end is **exclusive**  
  Example: `{startTime: '08:00', endTime: '09:00'}` covers `08:00` and `08:30` when slotMinutes=30

### Availability Model
Baseline schema:
```js
{
  userId: 'Penny',
  status: 'available' | 'unavailable',
  startTime: 'HH:MM',
  endTime: 'HH:MM',
  // For Feature 1, add:
  dayOfWeek: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun'
}
```
To support weekdays, encode in slot keys (e.g., `"Tue 18:00"`) and keep same merging semantics.

### Separation of Concerns
- **`index.js`**: LINE/HTTP/webhook plumbing only
- **`src/`**: Pure, testable functions with no LINE dependencies
- **`__tests__/`**: Jest tests for src/ modules
- Prefer small, focused modules (`src/parser.js`, `src/preferences.js`) over monolithic `index.js`

### Logging Convention
- ✅ Success/enabled features
- ⚠️ Warnings/degraded mode
- ❌ Errors
- 🚀 Startup messages
- **Always use Chinese** for user-facing logs

### Error Handling
- Return `Promise.resolve(null)` for unhandled events (don't throw)
- Check `if (!client)` before using LINE client features

## Feature Specifications

### Feature 1: Text-Based Group Scheduling

**Goal**: Parse Chinese natural language availability and suggest meeting times.

**Input Examples**:
- `我禮拜二後有空`
- `我週三晚上 6-9 點不行，其它都可以`
- `Penny 禮拜二後有空；Alex 禮拜三晚上不行，其它都可以`

**Implementation**:
1. Create `src/nlpParser.js` to parse Chinese text into structured availability
2. Rule-based parsing first; LLM integration later
3. Semantic rule: `我禮拜二後有空` = This week Tue-Fri, available after 18:00

**Default Time Windows** (centralize in `src/defaultTimeWindows.js`):
- Weekdays (Mon-Fri): `04:00–23:59`
- Weekends (Sat-Sun): `08:00–23:59`

**Evening Preference** (`18:00–23:00`):
- Implement `src/preferences.js` with `rankSlotsByPreference(candidates)`
- Boost slots in evening hours as "best discussion time"

**Query Handling**:
- `告訴我們禮拜二到禮拜四、18:00 到 22:00 可以開會的時間`
- Filter slots by weekday/time range → merge → find best → rank by preference

**Output Format** (text MVP):
```
星期二 19:00–21:00：3 個人可以開會（Penny 不行）

3/4（星期二） 19:00–21:00
- Penny: ❌
- Alex: ✅
- Bob: ✅
- Carol: ✅
```
Use plain text + emoji (✅/❌/⬜). Flex Messages can be added later.

### Feature 2: Calendar Image Parsing (AI Vision)

**Goal**: Parse timetable screenshots using AI vision to extract availability.

**Implementation**:
1. In `index.js`, detect `event.message.type === 'image'`
2. Download image via LINE content API
3. Create `src/visionParser.js` to call OpenAI Vision API
4. Prompt AI to output JSON matching availability schema:
   ```json
   [{
     "userId": "Penny",
     "dayOfWeek": "Mon",
     "status": "unavailable",
     "startTime": "09:00",
     "endTime": "12:00"
   }]
   ```
5. Convert to internal format and pass to `mergeAvailabilities`

**Error Handling**:
- On parse failure, reply: `無法自動辨識行事曆，麻煩改用文字描述你的時間～`
- Log errors for debugging

### Feature 3: Default Personal Schedule (常用行事曆)

**Goal**: Users can save a default timetable and reuse it across groups.

**Registration**:
- User sends image + command: `這是我的常用行事曆` or `儲存成常用行事曆`
- Parse image (Feature 2) and save to storage

**Usage**:
- Command: `套用我的常用行事曆` or `使用常用行事曆`
- Load stored availability for that userId
- Include in group's availability merge

**Storage Abstraction** (`src/calendarStore.js`):
```javascript
function saveUserDefaultCalendar(userId, availability) { ... }
function loadUserDefaultCalendar(userId) { ... }
```
Start with in-memory `Map` for MVP; abstraction enables easy database migration later.

## Integration Checklist for New Features

When adding features:
1. ✅ Create pure logic modules in `src/` (zero LINE/HTTP deps)
2. ✅ Add Jest tests in `__tests__/` following `scheduler.test.js` pattern
3. ✅ Route events in `index.js` by message type (text vs image)
4. ✅ Delegate to `src/` logic, reply via `client.replyMessage(event.replyToken, ...)`
5. ✅ Handle missing client gracefully with `if (!client)` checks
6. ✅ Use Chinese in console logs and user replies
7. ✅ Document any new time formats or data schemas in this file
