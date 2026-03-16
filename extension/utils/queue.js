/**
 * QueueManager — manages bulk-send queue state and persistence
 */
import { get, set } from "./storage.js";

const QUEUE_STORAGE_KEY = "wabm_queue_state";

export class QueueManager {
  constructor() {
    this.contacts = [];
    this.currentIndex = 0;
    this.status = "idle"; // idle | running | paused | stopped
    this._listeners = [];
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  async save() {
    await set(QUEUE_STORAGE_KEY, {
      contacts: this.contacts,
      currentIndex: this.currentIndex,
      status: this.status,
    });
  }

  async load() {
    const state = await get(QUEUE_STORAGE_KEY);
    if (state) {
      this.contacts = state.contacts || [];
      this.currentIndex = state.currentIndex || 0;
      this.status = state.status || "idle";
    }
    return this;
  }

  // ── Event emitter ─────────────────────────────────────────────────────────

  /**
   * Register a listener for queue status/progress events
   * @param {(event: { type: string, payload: any }) => void} listener
   */
  addListener(listener) {
    this._listeners.push(listener);
  }

  removeListener(listener) {
    this._listeners = this._listeners.filter((l) => l !== listener);
  }

  _emit(type, payload = {}) {
    const event = { type, payload };
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch (_) {
        // ignore listener errors
      }
    }
  }

  // ── Queue control ─────────────────────────────────────────────────────────

  /**
   * Initialise queue with a fresh contacts list and start
   * @param {Array<{name:string, phone:string}>} contacts
   */
  start(contacts) {
    this.contacts = contacts.map((c) => ({ ...c, status: "pending", timestamp: "", notes: "" }));
    this.currentIndex = 0;
    this.status = "running";
    this._emit("STATUS_CHANGED", { status: this.status });
    this.save();
  }

  pause() {
    if (this.status !== "running") return;
    this.status = "paused";
    this._emit("STATUS_CHANGED", { status: this.status });
    this.save();
  }

  resume() {
    if (this.status !== "paused") return;
    this.status = "running";
    this._emit("STATUS_CHANGED", { status: this.status });
    this.save();
  }

  stop() {
    this.status = "stopped";
    this._emit("STATUS_CHANGED", { status: this.status });
    this.save();
  }

  /**
   * Advance to the next contact; returns the contact or null when queue is exhausted
   * @returns {{ contact: object, index: number } | null}
   */
  next() {
    while (this.currentIndex < this.contacts.length) {
      const contact = this.contacts[this.currentIndex];
      if (contact.status === "pending") {
        const index = this.currentIndex;
        this.currentIndex++;
        this._emit("NEXT_CONTACT", { contact, index });
        this.save();
        return { contact, index };
      }
      this.currentIndex++;
    }
    // Queue exhausted
    if (this.status === "running") {
      this.status = "idle";
      this._emit("QUEUE_COMPLETE", { contacts: this.contacts });
      this.save();
    }
    return null;
  }

  /**
   * Update the status of a specific contact by index
   * @param {number} index
   * @param {"pending"|"sent"|"failed"|"skipped"} status
   * @param {string} [notes]
   */
  updateStatus(index, status, notes = "") {
    if (index < 0 || index >= this.contacts.length) return;
    this.contacts[index].status = status;
    this.contacts[index].timestamp = new Date().toISOString();
    if (notes) this.contacts[index].notes = notes;
    this._emit("CONTACT_STATUS_UPDATED", { index, contact: this.contacts[index] });
    this.save();
  }

  /** Snapshot of current progress */
  getProgress() {
    const total = this.contacts.length;
    const sent = this.contacts.filter((c) => c.status === "sent").length;
    const failed = this.contacts.filter((c) => c.status === "failed").length;
    const skipped = this.contacts.filter((c) => c.status === "skipped").length;
    const pending = this.contacts.filter((c) => c.status === "pending").length;
    return { total, sent, failed, skipped, pending, currentIndex: this.currentIndex };
  }
}
