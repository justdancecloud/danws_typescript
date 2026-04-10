/**
 * Global unique-port allocator for tests.
 *
 * Each worker process gets its own 2000-port range (deterministic from pid)
 * so parallel forks never collide. Within a worker, a counter hands out
 * monotonically increasing ports — across many test files and many tests
 * in a single fork, every server gets a unique bind port.
 *
 * Range layout:
 *   BASE = 30000
 *   WORKER_SLOT = pid % 30        → 30 parallel fork slots
 *   PORT = BASE + WORKER_SLOT*2000 + counter
 *
 * Max ports per worker: 2000 — far more than any realistic test run.
 */
const BASE = 30000;
const SLOT_SIZE = 2000;
const SLOTS = 30;

const workerSlot = (process.pid | 0) % SLOTS;
const workerBase = BASE + workerSlot * SLOT_SIZE;
let counter = 0;

export function nextPort(): number {
  if (counter >= SLOT_SIZE) counter = 0; // wrap (unlikely)
  return workerBase + counter++;
}
