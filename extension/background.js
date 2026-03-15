/**
 * Background service worker
 * Manages queue processing, tab lifecycle, and messaging with popup/content scripts
 */

// ── State ─────────────────────────────────────────────────────────────────────

let queue = {
  contacts: [],
  currentIndex: 0,
  status: "idle", // idle | running | paused | stopped
};

let settings = {
  minDelay: 15,
  maxDelay: 45,
  pauseEvery: 20,
  pauseDuration: 120,
};

let messageTemplate = "";
let activeTabId = null;
let sendResolve = null;
let sendReject = null;
let processedSinceLastPause = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMessage(template, contact) {
  const name = contact.name || "Friend";
  return template.replace(/\{Name\}/gi, name);
}

function broadcastStatus(extra = {}) {
  const progress = getProgress();
  chrome.runtime.sendMessage({
    type: "QUEUE_STATUS_UPDATE",
    ...progress,
    ...extra,
  }).catch(() => {
    // Popup may be closed — ignore
  });
}

function getProgress() {
  const total = queue.contacts.length;
  const sent = queue.contacts.filter((c) => c.status === "sent").length;
  const failed = queue.contacts.filter((c) => c.status === "failed").length;
  const skipped = queue.contacts.filter((c) => c.status === "skipped").length;
  const pending = queue.contacts.filter((c) => c.status === "pending").length;
  return {
    queueStatus: queue.status,
    total,
    sent,
    failed,
    skipped,
    pending,
    currentIndex: queue.currentIndex,
    contacts: queue.contacts,
  };
}

async function closeActiveTab() {
  if (activeTabId !== null) {
    try {
      await chrome.tabs.remove(activeTabId);
    } catch (_) {
      // Tab may already be closed
    }
    activeTabId = null;
  }
}

// ── Send a single contact ─────────────────────────────────────────────────────

async function sendToContact(contact) {
  const message = buildMessage(messageTemplate, contact);
  const url = `https://wa.me/${contact.phone.replace(/^\+/, "")}?text=${encodeURIComponent(message)}`;
  const SEND_TIMEOUT_MS = 30000;

  // Open the wa.me tab outside the Promise executor to avoid async-executor anti-pattern
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    activeTabId = tab.id;
  } catch (err) {
    return { success: false, reason: `Failed to open tab: ${err.message}` };
  }

  // Wait for the content script to confirm/deny the send
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve({ success: false, reason: "Timeout: send button not clicked within 30s" });
      }
    }, SEND_TIMEOUT_MS);

    function onMessage(msg, sender) {
      if (settled) return;
      if (sender.tab && sender.tab.id !== activeTabId) return;
      if (msg.type === "SEND_CONFIRMED") {
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve({ success: true });
      } else if (msg.type === "SEND_FAILED") {
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve({ success: false, reason: msg.reason || "Content script reported failure" });
      }
    }

    function cleanup() {
      chrome.runtime.onMessage.removeListener(onMessage);
    }

    chrome.runtime.onMessage.addListener(onMessage);
  });
}

// ── Main queue runner ─────────────────────────────────────────────────────────

async function runQueue() {
  while (queue.status === "running" && queue.currentIndex < queue.contacts.length) {
    // Find next pending contact
    let contact = null;
    let contactIndex = -1;

    while (queue.currentIndex < queue.contacts.length) {
      const c = queue.contacts[queue.currentIndex];
      if (c.status === "pending") {
        contact = c;
        contactIndex = queue.currentIndex;
        queue.currentIndex++;
        break;
      }
      queue.currentIndex++;
    }

    if (!contact) break; // No more pending contacts

    // Update to "sending"
    queue.contacts[contactIndex].status = "sending";
    broadcastStatus();

    // Send
    const result = await sendToContact(contact);

    // Close the tab
    await closeActiveTab();

    // Update status
    if (result.success) {
      queue.contacts[contactIndex].status = "sent";
      queue.contacts[contactIndex].timestamp = new Date().toISOString();
      processedSinceLastPause++;
    } else {
      queue.contacts[contactIndex].status = "failed";
      queue.contacts[contactIndex].timestamp = new Date().toISOString();
      queue.contacts[contactIndex].notes = result.reason || "";
      processedSinceLastPause++;
    }

    broadcastStatus();

    // Check if we need a longer pause
    if (
      settings.pauseEvery > 0 &&
      processedSinceLastPause >= settings.pauseEvery &&
      queue.currentIndex < queue.contacts.length
    ) {
      processedSinceLastPause = 0;
      const pauseMs = (settings.pauseDuration || 120) * 1000;
      broadcastStatus({ extendedPause: true, pauseSeconds: settings.pauseDuration });
      await sleep(pauseMs);
      broadcastStatus({ extendedPause: false });

      // Re-check queue status after the long pause (user may have paused/stopped)
      if (queue.status !== "running") break;
    }

    // Wait for the queue to resume if paused
    while (queue.status === "paused") {
      await sleep(500);
    }
    if (queue.status === "stopped") break;

    // Random delay between messages
    if (queue.currentIndex < queue.contacts.length) {
      const delay = randomDelay(settings.minDelay, settings.maxDelay);
      await sleep(delay);
    }

    // Re-check after delay
    while (queue.status === "paused") {
      await sleep(500);
    }
    if (queue.status === "stopped") break;
  }

  // Mark remaining pending contacts as skipped if stopped
  if (queue.status === "stopped") {
    queue.contacts.forEach((c) => {
      if (c.status === "pending") c.status = "skipped";
    });
  }

  if (queue.status !== "paused") {
    queue.status = "idle";
  }

  broadcastStatus();
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "START_QUEUE": {
      queue.contacts = (message.contacts || []).map((c) => ({
        ...c,
        status: "pending",
        timestamp: "",
        notes: "",
      }));
      queue.currentIndex = 0;
      queue.status = "running";
      messageTemplate = message.messageTemplate || "";
      settings = {
        minDelay: message.minDelay ?? 15,
        maxDelay: message.maxDelay ?? 45,
        pauseEvery: message.pauseEvery ?? 20,
        pauseDuration: message.pauseDuration ?? 120,
      };
      processedSinceLastPause = 0;
      broadcastStatus();
      runQueue();
      sendResponse({ ok: true });
      break;
    }

    case "PAUSE_QUEUE": {
      if (queue.status === "running") {
        queue.status = "paused";
        broadcastStatus();
      }
      sendResponse({ ok: true });
      break;
    }

    case "RESUME_QUEUE": {
      if (queue.status === "paused") {
        queue.status = "running";
        broadcastStatus();
        runQueue();
      }
      sendResponse({ ok: true });
      break;
    }

    case "STOP_QUEUE": {
      queue.status = "stopped";
      closeActiveTab();
      broadcastStatus();
      sendResponse({ ok: true });
      break;
    }

    case "GET_STATUS": {
      sendResponse(getProgress());
      break;
    }

    // SEND_CONFIRMED and SEND_FAILED are handled inside sendToContact's scoped listener
    default:
      break;
  }

  // Return true to keep the message channel open for async sendResponse if needed
  return true;
});
