// Counting time the way the patient is promised it: only between 8am and 8pm
// East Africa Time (UTC+3, no daylight saving). Keep these numbers in step
// with the service hours in src/lib/triage.js.

const EAT_OFFSET_MS = 3 * 60 * 60 * 1000
const OPEN_MIN = 8 * 60
const CLOSE_MIN = 20 * 60
const DAY_MS = 24 * 60 * 60 * 1000

// The moment that is `minutes` of opening time after `from`. Time outside
// service hours does not count, so a triage queued at 7:30pm and measured at
// 90 minutes is due at 9:00am the next morning.
export function addServiceMinutes(from, minutes) {
  const shifted = new Date(new Date(from).getTime() + EAT_OFFSET_MS)
  let day = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  let mins = shifted.getUTCHours() * 60 + shifted.getUTCMinutes() + shifted.getUTCSeconds() / 60

  if (mins < OPEN_MIN) mins = OPEN_MIN
  else if (mins >= CLOSE_MIN) {
    day += DAY_MS
    mins = OPEN_MIN
  }

  let remaining = minutes
  while (remaining > CLOSE_MIN - mins) {
    remaining -= CLOSE_MIN - mins
    day += DAY_MS
    mins = OPEN_MIN
  }
  mins += remaining

  return new Date(day + mins * 60000 - EAT_OFFSET_MS)
}
