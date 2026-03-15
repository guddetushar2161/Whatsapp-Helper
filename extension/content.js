/**
 * Content script — injected into https://web.whatsapp.com/*
 * Waits for the send button and clicks it, then reports result to background.
 */

(function () {
  "use strict";

  const SEND_SELECTORS = [
    '[data-testid="send"]',
    'button[aria-label="Send"]',
    'span[data-testid="send"]',
    'button[data-testid="compose-btn-send"]',
  ];

  const OBSERVE_TIMEOUT_MS = 15000;

  let triggered = false;

  /**
   * Find the send button in the DOM using multiple selectors
   */
  function findSendButton() {
    for (const sel of SEND_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /**
   * Attempt to click the send button. Returns true if clicked successfully.
   */
  function trySend() {
    const btn = findSendButton();
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }

  /**
   * Wait for the send button to appear using a MutationObserver + timeout fallback
   */
  function waitAndSend() {
    // Try immediately first (page may already have a message pre-filled via ?text=)
    if (trySend()) {
      chrome.runtime.sendMessage({ type: "SEND_CONFIRMED" });
      return;
    }

    let observer = null;
    let timeoutId = null;
    let resolved = false;

    function resolve(success, reason) {
      if (resolved) return;
      resolved = true;
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (success) {
        chrome.runtime.sendMessage({ type: "SEND_CONFIRMED" });
      } else {
        chrome.runtime.sendMessage({ type: "SEND_FAILED", reason });
      }
    }

    // Set up MutationObserver to watch for send button appearing
    // Observe a more targeted container: the message input footer area, falling back to body
    const targetNode =
      document.querySelector('[data-testid="conversation-compose-box"]') ||
      document.querySelector("footer") ||
      document.body;

    observer = new MutationObserver(() => {
      if (trySend()) {
        resolve(true);
      }
    });

    observer.observe(targetNode, { childList: true, subtree: true });

    // Timeout fallback
    timeoutId = setTimeout(() => {
      resolve(false, "Send button did not appear within 15 seconds");
    }, OBSERVE_TIMEOUT_MS);
  }

  // ── Listen for TRIGGER_SEND from background.js ──────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "TRIGGER_SEND") {
      if (!triggered) {
        triggered = true;
        waitAndSend();
      }
      sendResponse({ ok: true });
    }
  });

  // ── Auto-trigger when navigated to wa.me redirect ──────────────────────────
  // WhatsApp Web opens via wa.me link, which auto-loads the chat and pre-fills text.
  // The content script fires on DOMContentLoaded / load.
  function autoTrigger() {
    if (triggered) return;
    triggered = true;
    waitAndSend();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoTrigger);
  } else {
    // DOMContentLoaded already fired — wait a short tick then try
    setTimeout(autoTrigger, 800);
  }
})();
