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
let imageAttachment = null; // {name, type, size, dataUrl} | null
let activeTabId = null;
let processedSinceLastPause = 0;
const MAX_WEB_OPEN_RETRIES = 2;
let isQueueRunnerActive = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSettings(rawSettings = {}) {
  let minDelay = Math.max(5, Math.floor(toNumber(rawSettings.minDelay, 15)));
  let maxDelay = Math.max(5, Math.floor(toNumber(rawSettings.maxDelay, 45)));
  if (maxDelay < minDelay) {
    const t = minDelay;
    minDelay = maxDelay;
    maxDelay = t;
  }

  const pauseEvery = Math.max(0, Math.floor(toNumber(rawSettings.pauseEvery, 20)));
  const pauseDuration = Math.max(30, Math.floor(toNumber(rawSettings.pauseDuration, 120)));

  return {
    minDelay,
    maxDelay,
    pauseEvery,
    pauseDuration,
  };
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

function isSkippableReason(reason) {
  const text = String(reason || "").toLowerCase();
  return (
    text.includes("not on whatsapp") ||
    text.includes("number unavailable") ||
    text.includes("invalid phone") ||
    text.includes("phone number shared via url is invalid")
  );
}

async function findExistingWhatsAppWebTab() {
  const tabs = await chrome.tabs.query({ url: ["https://web.whatsapp.com/*"] });
  return tabs.find((tab) => Number.isInteger(tab.id)) || null;
}

async function selectQueueWhatsAppTab() {
  const tabs = await chrome.tabs.query({ url: ["https://web.whatsapp.com/*"] });
  if (!tabs || tabs.length === 0) {
    throw new Error("Open and log in to WhatsApp Web first, then start the queue.");
  }

  const preferred =
    tabs.find((t) => t.active && t.windowId === chrome.windows.WINDOW_ID_CURRENT) ||
    tabs.find((t) => t.active) ||
    tabs[0];

  if (!preferred || !Number.isInteger(preferred.id)) {
    throw new Error("Could not find a valid WhatsApp Web tab.");
  }

  activeTabId = preferred.id;

  try {
    await chrome.windows.update(preferred.windowId, { focused: true });
    await chrome.tabs.update(activeTabId, { active: true });
  } catch (_) {
    // If focusing fails, queue can still continue in background.
  }

  return activeTabId;
}

function waitForWhatsAppTabReady(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let done = false;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timeout waiting for WhatsApp Web tab to load"));
    }, timeoutMs);

    function cleanup() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }

    function onUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId) return;
      const isComplete = changeInfo.status === "complete";
      const isWhatsApp = tab && typeof tab.url === "string" && tab.url.includes("web.whatsapp.com");
      const hasNonWebUrl =
        tab &&
        typeof tab.url === "string" &&
        !tab.url.includes("web.whatsapp.com") &&
        (tab.url.startsWith("whatsapp:") || tab.url.startsWith("intent:") || tab.url.startsWith("ms-windows-store:"));
      if (hasNonWebUrl) {
        cleanup();
        reject(new Error("Detected external app redirect instead of WhatsApp Web"));
        return;
      }
      if (isComplete && isWhatsApp) {
        cleanup();
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);

    chrome.tabs.get(tabId).then((tab) => {
      const alreadyReady =
        tab &&
        tab.status === "complete" &&
        typeof tab.url === "string" &&
        tab.url.includes("web.whatsapp.com");
      if (alreadyReady) {
        cleanup();
        resolve();
      }
    }).catch(() => {
      // Ignore; onUpdated listener + timeout handles failures.
    });
  });
}

async function triggerSendAction(tabId, payload) {
  return chrome.tabs.sendMessage(tabId, {
    type: "TRIGGER_SEND",
    ...payload,
  });
}

async function ensureWhatsAppWebTab(url) {
  if (activeTabId === null) {
    await selectQueueWhatsAppTab();
  }

  try {
    await chrome.tabs.get(activeTabId);
  } catch (_) {
    await selectQueueWhatsAppTab();
  }

  await chrome.tabs.update(activeTabId, { url, active: true });
  await waitForWhatsAppTabReady(activeTabId, 30000);
  return activeTabId;
}

async function openWhatsAppWebTabWithRetry(url, maxRetries = MAX_WEB_OPEN_RETRIES) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await ensureWhatsAppWebTab(url);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await sleep(1200);
      }
    }
  }
  throw lastError || new Error("Unable to open WhatsApp Web tab");
}

// ── Send a single contact ─────────────────────────────────────────────────────

async function sendToContact(contact) {
  const message = buildMessage(messageTemplate, contact);
  const hasImage = false;
  const phone = contact.phone.replace(/^\+/, "");
  const params = new URLSearchParams({
    phone,
    type: "phone_number",
    app_absent: "1",
  });
  if (!hasImage) {
    params.set("text", message);
  }
  const url = `https://web.whatsapp.com/send?${params.toString()}`;
  const SEND_TIMEOUT_MS = hasImage ? 60000 : 30000;

  try {
    await openWhatsAppWebTabWithRetry(url);
  } catch (err) {
    return { success: false, reason: `Failed to open WhatsApp Web chat: ${err.message}` };
  }

  // Wait for the content script to confirm/deny the send.
  // Listener must be attached before TRIGGER_SEND to avoid missing fast responses.
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve({ success: false, reason: `Timeout: send flow not completed within ${Math.floor(SEND_TIMEOUT_MS / 1000)}s` });
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

    triggerSendAction(activeTabId, {
      mode: hasImage ? "IMAGE_THEN_TEXT" : "TEXT_ONLY",
      messageText: message,
      imageAttachment: hasImage ? imageAttachment : null,
    }).catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({ success: false, reason: `Failed to trigger send action: ${err.message}` });
    });
  });
}

// ── Main queue runner ─────────────────────────────────────────────────────────

async function runQueue() {
  if (isQueueRunnerActive) return;
  isQueueRunnerActive = true;

  try {
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

    // Update status
    if (result.success) {
      queue.contacts[contactIndex].status = "sent";
      queue.contacts[contactIndex].timestamp = new Date().toISOString();
      processedSinceLastPause++;
    } else {
      queue.contacts[contactIndex].status = isSkippableReason(result.reason) ? "skipped" : "failed";
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
  } finally {
    isQueueRunnerActive = false;
  }
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "START_QUEUE": {
      (async () => {
        try {
          await selectQueueWhatsAppTab();
          queue.contacts = (message.contacts || []).map((c) => ({
            ...c,
            status: "pending",
            timestamp: "",
            notes: "",
          }));
          queue.currentIndex = 0;
          queue.status = "running";
          messageTemplate = message.messageTemplate || "";
          imageAttachment = null;
          settings = normalizeSettings(message);
          processedSinceLastPause = 0;
          broadcastStatus();
          runQueue();
          sendResponse({ ok: true });
        } catch (err) {
          queue.status = "idle";
          sendResponse({ ok: false, error: err.message || "Failed to start queue" });
        }
      })();
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
        if (!isQueueRunnerActive) {
          runQueue();
        }
      }
      sendResponse({ ok: true });
      break;
    }

    case "STOP_QUEUE": {
      queue.status = "stopped";
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
