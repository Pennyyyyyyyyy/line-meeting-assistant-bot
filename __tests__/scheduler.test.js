// __tests__/scheduler.test.js
const {
  generateTimeSlots,
  mergeAvailabilities,
  findBestSlots,
} = require('../src/scheduler');

test('generateTimeSlots returns half-hour slots between start and end', () => {
  const slots = generateTimeSlots({ startHour: 8, endHour: 10, slotMinutes: 30 });
  expect(slots).toEqual(['08:00', '08:30', '09:00', '09:30']);
});

test('mergeAvailabilities marks user as available in the correct slots', () => {
  const slots = ['08:00', '08:30', '09:00', '09:30'];

  const availabilities = [
    {
      userId: 'Emory',
      status: 'available',
      startTime: '08:00',
      endTime: '09:00', // 會覆蓋 08:00, 08:30 兩格
    },
  ];

  const merged = mergeAvailabilities(slots, availabilities);

  expect(merged['08:00'].available).toContain('Emory');
  expect(merged['08:30'].available).toContain('Emory');
  // 09:00 之後不應該還有 Emory
  expect(merged['09:00'].available).not.toContain('Emory');
});

test('findBestSlots finds the slot with the largest number of common available users', () => {
  const slots = ['08:00', '08:30', '09:00', '09:30'];

  const availabilities = [
    {
      userId: 'Emory',
      status: 'available',
      startTime: '08:00',
      endTime: '09:00', // 08:00, 08:30
    },
    {
      userId: 'Alex',
      status: 'available',
      startTime: '08:30',
      endTime: '09:30', // 08:30, 09:00
    },
  ];

  const merged = mergeAvailabilities(slots, availabilities);

  // 會議長度 = 1 個 slot → 08:30 應該有 Emory + Alex
  const result = findBestSlots(merged, 1);

  expect(result.bestCount).toBe(2);

  const allCandidateSlots = result.candidates.flatMap((c) => c.slots);
  expect(allCandidateSlots).toContain('08:30');
});
