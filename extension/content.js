/**
 * Content script — injected into https://web.whatsapp.com/*
 * Handles text-only send and optional image-then-text send workflows.
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

  const ATTACH_BUTTON_SELECTORS = [
    '[data-testid="clip"]',
    'span[data-icon="attach-menu-plus"]',
    'span[data-icon="plus"]',
    '[aria-label="Attach"]',
    '[data-testid="attach-media"]',
    'button[title="Attach"]',
    'div[title="Attach"]',
  ];

  const CHAT_INPUT_SELECTORS = [
    'footer [contenteditable="true"][role="textbox"]',
    '[data-testid="conversation-compose-box-input"]',
    'div[contenteditable="true"][role="textbox"]',
  ];

  const MEDIA_CAPTION_INPUT_SELECTORS = [
    '[data-testid="media-caption-input-container"] [contenteditable="true"][role="textbox"]',
    '[data-testid="media-caption-input"] [contenteditable="true"][role="textbox"]',
    '[data-testid="media-compose"] [contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][data-tab="1"]',
  ];

  const MEDIA_SEND_BUTTON_SELECTORS = [
    '[data-testid="media-caption-send-button"]',
    '[data-testid="media-send"]',
    'button[aria-label="Send"]',
    'span[data-testid="send"]',
  ];

  const WAIT_TIMEOUT_MS = 20000;
  const MEDIA_RENDER_WAIT_MS = 1200;
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

  function findAttachButton() {
    for (const sel of ATTACH_BUTTON_SELECTORS) {
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

  function isVisible(el) {
    return !!(el && el.isConnected && el.getClientRects && el.getClientRects().length > 0);
  }

  function findMediaCaptionInput() {
    for (const sel of MEDIA_CAPTION_INPUT_SELECTORS) {
      const matches = Array.from(document.querySelectorAll(sel));
      const visible = matches.find(isVisible);
      if (visible) return visible;
    }
    return null;
  }

  function findMediaSendButton() {
    for (const sel of MEDIA_SEND_BUTTON_SELECTORS) {
      const matches = Array.from(document.querySelectorAll(sel));
      const visible = matches.find(isVisible);
      if (visible) return visible;
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
      await sleep(400);
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

      const targetNode = document.body;
      const observer = new MutationObserver(() => {
        const btn = findSendButton();
        if (btn) {
          observer.disconnect();
          clearTimeout(timeoutId);
          resolve(btn);
        }
      });

      observer.observe(targetNode, { childList: true, subtree: true });

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
    // After the chat UI loads, keep polling for a short grace window so that
    // a deferred "isn't on WhatsApp" modal (which appears ~1-2s after load) is
    // caught before we attempt to send.
    const GRACE_MS = 1500;
    let chatReadyAt = null;

    while (Date.now() - started < timeoutMs) {
      if (isUnavailableNumberVisible()) {
        await dismissUnavailablePopup();
        throw new Error("Number unavailable: contact is not on WhatsApp");
      }

      const isReady = !!(findChatInput() || findSendButton() || findAttachButton());
      if (isReady) {
        if (!chatReadyAt) chatReadyAt = Date.now();
        // Only proceed once the grace period has elapsed without a modal appearing
        if (Date.now() - chatReadyAt >= GRACE_MS) {
          return;
        }
      }

      await sleep(150);
    }

    throw new Error("Chat did not become ready in time");
  }

  function waitForImageFileInput(timeoutMs = WAIT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const findInput = () => {
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
        return inputs.find((input) => (input.accept || "").toLowerCase().includes("image")) || null;
      };

      const immediate = findInput();
      if (immediate) {
        resolve(immediate);
        return;
      }

      const observer = new MutationObserver(() => {
        const input = findInput();
        if (input) {
          observer.disconnect();
          clearTimeout(timeoutId);
          resolve(input);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      const timeoutId = setTimeout(() => {
        observer.disconnect();
        reject(new Error("Image picker input did not appear in time"));
      }, timeoutMs);
    });
  }

  async function waitForMediaComposerReady(timeoutMs = WAIT_TIMEOUT_MS) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const caption = findMediaCaptionInput();
      const sendBtn = findMediaSendButton();
      if (caption && sendBtn) {
        return { caption, sendBtn };
      }
      await sleep(120);
    }
    throw new Error("Media composer did not become ready in time");
  }

  async function sendMediaWithCaption(captionText) {
    const { caption, sendBtn } = await waitForMediaComposerReady();
    const trimmed = (captionText || "").trim();

    if (trimmed) {
      caption.focus();
      caption.textContent = trimmed;
      caption.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: trimmed,
        inputType: "insertText",
      }));
      await sleep(250);
    }

    sendBtn.click();
  }

  async function dataUrlToFile(dataUrl, name, type) {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    return new File([blob], name || "image.png", { type: type || blob.type || "image/png" });
  }

  // Primary image strategy: dispatch a synthetic paste event carrying the image
  // file directly onto the compose input. WhatsApp Web's paste handler picks it
  // up and shows the media-preview dialog — no need to navigate the clip/attach
  // button menu.  Uses a short 5 s send-button timeout so failures fall through
  // quickly to the clip-button fallback.
  async function attachImageViaPasteEvent(imageAttachment, captionText) {
    const file = await dataUrlToFile(
      imageAttachment.dataUrl,
      imageAttachment.name,
      imageAttachment.type
    );

    const chatInput = await waitForElement(
      findChatInput,
      "Chat input not found for image paste",
      8000
    );
    chatInput.focus();
    await sleep(200);

    const dt = new DataTransfer();
    dt.items.add(file);

    // Dispatch on the compose input AND the footer — WhatsApp may listen at
    // either level depending on its React version.
    const targets = [chatInput, document.querySelector("footer")].filter(Boolean);
    for (const target of targets) {
      try {
        target.dispatchEvent(
          new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt })
        );
      } catch (_) {
        // Older Chrome build: fall back to plain Event with defineProperty
        try {
          const ev = new Event("paste", { bubbles: true, cancelable: true });
          Object.defineProperty(ev, "clipboardData", { value: dt, configurable: true });
          target.dispatchEvent(ev);
        } catch (_2) { /* ignore */ }
      }
    }

    // Allow WhatsApp to process the paste and render the media preview
    await sleep(1500);
    await sendMediaWithCaption(captionText);
  }

  async function attachAndSendImage(imageAttachment, captionText) {
    // ── Strategy 1: clipboard paste event (no menu navigation required) ──────
    try {
      await attachImageViaPasteEvent(imageAttachment, captionText);
      return; // success
    } catch (_pasteErr) {
      // Paste strategy failed; fall through to clip-button approach
    }

    // ── Strategy 2: click attach/clip button → inject file into file input ───
    const attachBtn = await waitForElement(
      findAttachButton,
      "Attach button not found — please ensure WhatsApp Web is fully loaded."
    );
    attachBtn.click();

    const input = await waitForImageFileInput();
    const file = await dataUrlToFile(
      imageAttachment.dataUrl,
      imageAttachment.name,
      imageAttachment.type
    );

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await sleep(MEDIA_RENDER_WAIT_MS);
    await sendMediaWithCaption(captionText);
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

    await sleep(250);
    await clickSendButton();
  }

  async function processTrigger(message) {
    const mode = message.mode || "TEXT_ONLY";
    const text = message.messageText || "";

    await waitForChatReadyOrUnavailable();

    if (mode === "IMAGE_THEN_TEXT") {
      if (!message.imageAttachment || !message.imageAttachment.dataUrl) {
        throw new Error("Image attachment payload is missing.");
      }
      await attachAndSendImage(message.imageAttachment, text);
      return;
    }

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
