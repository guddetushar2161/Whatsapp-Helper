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

  // Generous timeout — valid WhatsApp numbers may load slowly on some networks.
  // Non-WhatsApp numbers are detected instantly via MutationObserver (no polling).
  const WAIT_TIMEOUT_MS = 15000;

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
    // Check specific dialog / alert containers first — much faster than scanning the entire body.
    const containers = document.querySelectorAll(
      '[data-testid="alert-popup"], [data-testid="confirm-popup"], [role="alertdialog"], [role="dialog"], [role="alert"]'
    );

    for (const el of containers) {
      const text = (el.innerText || el.textContent || "").toLowerCase();
      if (UNAVAILABLE_PATTERNS.some((p) => text.includes(p))) return true;
    }

    // Fallback: full body scan (handles inline error messages outside dialogs)
    const body = document.body ? document.body.innerText : "";
    return UNAVAILABLE_PATTERNS.some((p) => body.toLowerCase().includes(p));
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

  /**
   * Wait for either the chat compose box to appear OR an "unavailable" modal.
   * Uses MutationObserver — zero polling, resolves/rejects the instant the DOM changes.
   * For valid WhatsApp numbers the input typically appears in 2-5 s.
   * For non-WhatsApp numbers the error modal is detected within one DOM mutation tick.
   */
  function waitForChatOrUnavailable(timeoutMs = WAIT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      // Immediate check before attaching observer (handles pre-loaded pages)
      if (isUnavailableNumberVisible()) {
        dismissUnavailablePopup().catch(() => {});
        reject(new Error("Number unavailable: contact is not on WhatsApp"));
        return;
      }
      if (findChatInput() || findSendButton()) {
        resolve();
        return;
      }

      let settled = false;

      function finish(err) {
        if (settled) return;
        settled = true;
        clearTimeout(tid);
        observer.disconnect();
        if (err) reject(err);
        else resolve();
      }

      const observer = new MutationObserver(() => {
        if (settled) return;
        if (isUnavailableNumberVisible()) {
          dismissUnavailablePopup().catch(() => {});
          finish(new Error("Number unavailable: contact is not on WhatsApp"));
          return;
        }
        if (findChatInput() || findSendButton()) {
          finish();
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      const tid = setTimeout(
        () => finish(new Error("Chat did not become ready in time")),
        timeoutMs
      );
    });
  }

  async function clickSendButton() {
    const btn = findSendButton();
    if (!btn) throw new Error("Send button not found after chat was ready");
    btn.click();
  }

  async function sendTextMessage(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) {
      return;
    }

    // Chat input is guaranteed to exist when waitForChatOrUnavailable resolved via
    // findChatInput().  If it resolved via findSendButton() (text was pre-filled by the
    // URL param), input may be absent — in that case skip filling and click send directly.
    const input = findChatInput();
    if (input) {
      input.focus();
      input.textContent = trimmed;
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: trimmed,
        inputType: "insertText",
      }));
      await sleep(100);
    }

    await clickSendButton();
  }

  async function processTrigger(message) {
    const text = message.messageText || "";
    await waitForChatOrUnavailable();
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

