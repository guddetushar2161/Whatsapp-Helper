/**
 * Content script — injected into https://web.whatsapp.com/*
 * Handles text-only send workflow.
 */

(function () {
  "use strict";

  const SEND_SELECTORS = [
    '[data-testid="send"]',
    '[data-testid="media-caption-send-button"]',
    'button[aria-label="Send"]',
    'span[data-testid="send"]',
    'button[data-testid="compose-btn-send"]',
  ];

  const CHAT_INPUT_SELECTORS = [
    'footer [contenteditable="true"][role="textbox"]',
    '[data-testid="conversation-compose-box-input"]',
    'div[contenteditable="true"][role="textbox"]',
  ];

  // Reduced from 20 000 ms — chat UI loads quickly once navigated
  const WAIT_TIMEOUT_MS = 12000;
  // Reduced from 1 500 ms — grace window for "not on WhatsApp" modal detection
  const GRACE_MS = 500;

  const UNAVAILABLE_PATTERNS = [
    "phone number shared via url is invalid",
    "phone number isn't on whatsapp",
    "phone number is not on whatsapp",
    "isn't on whatsapp",
    "number isn't on whatsapp",
    "not registered on whatsapp",
    "couldn't find",
    "not on whatsapp",
    "invalid phone number",
    "check the phone number",
  ];

  // Selectors for the OK/Dismiss button in WhatsApp Web's "not on WhatsApp" alert modal
  const UNAVAILABLE_POPUP_OK_SELECTORS = [
    '[data-testid="popup-controls-ok-confirm"]',
    '[data-testid="confirm-popup-ok"]',
    '[data-testid="alert-popup-ok"]',
    '[data-testid="modal-confirm-button"]',
  ];

  let inProgress = false;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function findSendButton() {
    for (const sel of SEND_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findChatInput() {
    for (const sel of CHAT_INPUT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function isUnavailableNumberVisible() {
    const text = (document.body && document.body.innerText ? document.body.innerText : "").toLowerCase();
    return UNAVAILABLE_PATTERNS.some((pattern) => text.includes(pattern));
  }

  // Automatically click the OK button on the "isn't on WhatsApp" modal so it
  // doesn't block the UI for the next contact.
  async function dismissUnavailablePopup() {
    let okBtn = null;
    for (const sel of UNAVAILABLE_POPUP_OK_SELECTORS) {
      okBtn = document.querySelector(sel);
      if (okBtn) break;
    }
    if (!okBtn) {
      // Generic fallback: find a button/role=button whose visible text is "OK"
      okBtn = Array.from(document.querySelectorAll('div[role="button"], button'))
        .find((el) => /^\s*OK\s*$/i.test((el.textContent || "").trim()));
    }
    if (okBtn) {
      okBtn.click();
      await sleep(300);
    }
  }

  function waitForElement(findFn, notFoundMessage, timeoutMs = WAIT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const immediate = findFn();
      if (immediate) {
        resolve(immediate);
        return;
      }

      const observer = new MutationObserver(() => {
        const element = findFn();
        if (element) {
          observer.disconnect();
          clearTimeout(timeoutId);
          resolve(element);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      const timeoutId = setTimeout(() => {
        observer.disconnect();
        reject(new Error(notFoundMessage));
      }, timeoutMs);
    });
  }

  function waitForSendButton(timeoutMs = WAIT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const immediate = findSendButton();
      if (immediate) {
        resolve(immediate);
        return;
      }

      const observer = new MutationObserver(() => {
        const btn = findSendButton();
        if (btn) {
          observer.disconnect();
          clearTimeout(timeoutId);
          resolve(btn);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      const timeoutId = setTimeout(() => {
        observer.disconnect();
        reject(new Error("Send button did not appear in time"));
      }, timeoutMs);
    });
  }

  async function clickSendButton() {
    const btn = await waitForSendButton();
    btn.click();
  }

  async function waitForChatReadyOrUnavailable(timeoutMs = WAIT_TIMEOUT_MS) {
    const started = Date.now();
    let chatReadyAt = null;

    while (Date.now() - started < timeoutMs) {
      if (isUnavailableNumberVisible()) {
        await dismissUnavailablePopup();
        throw new Error("Number unavailable: contact is not on WhatsApp");
      }

      const isReady = !!(findChatInput() || findSendButton());
      if (isReady) {
        if (!chatReadyAt) chatReadyAt = Date.now();
        // Only proceed once the grace period has elapsed without a modal appearing
        if (Date.now() - chatReadyAt >= GRACE_MS) {
          return;
        }
      }

      await sleep(120);
    }

    throw new Error("Chat did not become ready in time");
  }

  async function sendTextMessage(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) {
      return;
    }

    const input = await waitForElement(
      findChatInput,
      "Message input box not found."
    );

    input.focus();
    input.textContent = trimmed;
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: trimmed,
      inputType: "insertText",
    }));

    await sleep(100);
    await clickSendButton();
  }

  async function processTrigger(message) {
    const text = message.messageText || "";
    await waitForChatReadyOrUnavailable();
    await sendTextMessage(text);
  }

  // ── Listen for TRIGGER_SEND from background.js ──────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "TRIGGER_SEND") return;

    if (inProgress) {
      sendResponse({ ok: false, reason: "Send action already in progress" });
      return;
    }

    inProgress = true;

    processTrigger(message)
      .then(() => {
        chrome.runtime.sendMessage({ type: "SEND_CONFIRMED" });
        sendResponse({ ok: true });
      })
      .catch((err) => {
        chrome.runtime.sendMessage({
          type: "SEND_FAILED",
          reason: err && err.message ? err.message : "Unknown send error",
        });
        sendResponse({ ok: false, reason: err && err.message ? err.message : "Unknown send error" });
      })
      .finally(() => {
        inProgress = false;
      });

    return true;
  });
})();

