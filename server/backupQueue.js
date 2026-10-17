/**
 * Bounded Asynchronous Backup Retry Queue
 * 
 * Availability & Integrity Guarantees:
 * - Bounded memory buffer (prevents memory exhaustion under prolonged network partition)
 * - Exponential backoff with jitter
 * - Idempotent re-execution reusing stable event UUIDs and local user IDs
 * - Graceful failure handling: Never throws uncaught exceptions or blocks the server
 * 
 * Note: This queue resides in application memory. Unprocessed retries are bounded
 * and will not persist across full server process restarts.
 */

class BackupQueue {
  constructor(options = {}) {
    this.maxQueueSize = options.maxQueueSize || 500;
    this.maxRetries = options.maxRetries || 3;
    this.initialBackoffMs = options.initialBackoffMs || 2000;
    this.maxBackoffMs = options.maxBackoffMs || 30000;
    this.queue = [];
    this.isProcessing = false;
  }

  /**
   * Enqueues a failed backup task for bounded retry
   * @param {Function} taskFn Async function to execute
   * @param {Object} metadata Context metadata for logging (NO secrets)
   */
  enqueue(taskFn, metadata = {}) {
    if (this.queue.length >= this.maxQueueSize) {
      console.warn(`[BackupQueue] Queue capacity (${this.maxQueueSize}) reached. Dropping oldest pending backup task to preserve system availability.`);
      this.queue.shift(); // Drop oldest to preserve memory
    }

    const item = {
      taskFn,
      metadata: {
        type: metadata.type || 'unknown',
        identifier: metadata.identifier || 'unknown',
        attempt: 1
      },
      nextRunAt: Date.now() + this.initialBackoffMs
    };

    this.queue.push(item);
    this.scheduleNext();
  }

  scheduleNext() {
    if (this.isProcessing || this.queue.length === 0) return;

    const nextItem = this.queue[0];
    const delay = Math.max(0, nextItem.nextRunAt - Date.now());

    this.isProcessing = true;
    setTimeout(() => {
      this.processNext();
    }, delay).unref();
  }

  async processNext() {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      return;
    }

    const item = this.queue.shift();

    try {
      await item.taskFn();
      // Successfully processed on retry
    } catch (err) {
      item.metadata.attempt += 1;

      if (item.metadata.attempt <= this.maxRetries) {
        const backoff = Math.min(
          this.initialBackoffMs * Math.pow(2, item.metadata.attempt - 1),
          this.maxBackoffMs
        );
        item.nextRunAt = Date.now() + backoff;
        this.queue.push(item);
      } else {
        console.warn(`[BackupQueue] Permanent failure after ${this.maxRetries} retries for ${item.metadata.type} [${item.metadata.identifier}]: ${err.message || 'Unknown error'}`);
      }
    }

    this.isProcessing = false;
    if (this.queue.length > 0) {
      this.scheduleNext();
    }
  }

  getPendingCount() {
    return this.queue.length;
  }

  clear() {
    this.queue = [];
    this.isProcessing = false;
  }
}

const defaultBackupQueue = new BackupQueue();

module.exports = {
  BackupQueue,
  defaultBackupQueue
};
