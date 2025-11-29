# 到底什麼時候有空？ — LINE Meeting Assistant Bot

A LINE bot that helps groups quickly find meeting times by collecting availability from each member and suggesting the best overlapping time slots.

---

## Motivation

Coordinating meeting times for different course groups is something I face almost every semester. We usually rely on When2Meet, but it has several drawbacks:

1. Users must manually fill their availability every time  
2. Color gradients become unclear when many members participate  
3. It’s difficult to see *who* is unavailable at specific time slots  

Since university students primarily communicate in LINE group chats, having a scheduling tool directly inside LINE is much more convenient. LINE’s built-in “Pick a Date” feature cannot handle time ranges, so groups still send When2Meet links.

To streamline this workflow, I created **Hoppy**, a LINE meeting assistant bot that collects availability, merges updates, and recommends meeting times—without ever leaving LINE.

---

## Features

- Natural-language availability input  
- Auto-merging and updating of free/busy time  
- Best-slot suggestion based on group overlap  
- Partial-match ranking when no perfect overlap exists  
- Optional course-schedule parsing for auto-filled availability  
- Designed for real LINE group chats, no external site required  

---

## Technical Highlights

- **Conversation-scoped availability management** using an extensible in-memory structure  
- **Incremental merging** of availability (splits and adjusts ranges instead of overwriting)  
- **Modular scheduling engine** for slot generation, range merging, intersection, partial scoring  
- **Natural-language time parsing** in Chinese and English  
- **Clean separation** of LINE webhook logic and scheduling logic for easy future expansion  

---

## Usage Examples

Hoppy supports two methods for providing availability.

---

# Example 1 — Natural-Language Input

### Add availability  
`我 20:00–22:00 有空`

### Update availability  
`我 20:00–20:30 不行`

→ Automatically adjusts to keep **20:30–22:00** free.

<img src="https://github.com/user-attachments/assets/d9d2dec4-e621-44a4-b29f-37c310e18dcd" width="300">

---

# Example 2 — Uploading a Course Schedule (課表)

### Step 1 — Private chat  
Upload your course schedule, and Hoppy will parse and store it as weekly availability.

<img src="https://github.com/user-attachments/assets/def51c4a-c2ca-4a67-b87f-ec2f6093db09" width="300">

### Step 2 — Group chat  
Members auto-fill availability using:
用課表填星期二

Hoppy replies with their free intervals for the selected day.

### Step 3 — Ask for the best meeting time  
開會時間？


Hoppy returns the earliest slot (after 18:00) where all members are available.

<img src="https://github.com/user-attachments/assets/a327d45d-27b9-4d2f-8503-1d653ef1781f" width="300">

---

## Getting Started

This project requires a LINE Messaging API channel.

### Clone and install
```bash
git clone https://github.com/Pennyyyyyyyyy/line-meeting-assistant-bot.git
cd line-meeting-assistant-bot
npm install

### Create .env
```bash
CHANNEL_SECRET=xxx
CHANNEL_ACCESS_TOKEN=xxx
PORT=3000

###Run
```bash
npm start

flowchart TD
    A[LINE User<br>(messages / timetable upload)]
    B[LINE Messaging API<br>Webhook delivery]
    C[Express Server<br>index.js]
    D[Availability Store<br>conversation-based storage]
    E[Scheduling Engine<br>slot generation, merging, scoring]
    F[LINE Reply API]
    G[User Receives Meeting Time Suggestions]

    A --> B --> C
    C --> D
    C --> E
    E --> F --> G





