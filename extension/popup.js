/**
 * popup.js — ES6 module controller for WhatsApp Bulk Messenger popup
 */
import { cleanAndValidateNumbers, deduplicateContacts } from "./utils/parser.js";
import { readFile } from "./utils/excelReader.js";
import { exportToXlsx, exportToCsv } from "./utils/excelWriter.js";
import { saveTemplate, loadTemplates, deleteTemplate, saveSettings, loadSettings } from "./utils/storage.js";

// ── Module-level state ────────────────────────────────────────────────────────

let contacts = [];         // Array<{name, phone, status, timestamp, notes}>
let invalidContacts = [];  // Array<{phone, reason}>
let duplicatesRemoved = 0;
let totalRawCount = 0;

// ── DOM helpers ───────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTimestamp(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch (_) {
    return iso;
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────

function initNavigation() {
  const navItems = document.querySelectorAll(".nav-item");
  const sections = document.querySelectorAll(".section");

  navItems.forEach((item) => {
    item.addEventListener("click", () => {
      const target = item.dataset.section;
      navItems.forEach((n) => n.classList.remove("active"));
      sections.forEach((s) => s.classList.remove("active"));
      item.classList.add("active");
      const sec = $(target);
      if (sec) sec.classList.add("active");

      if (target === "step4") renderReport();
      if (target === "step2") updateMessagePreview();
    });
  });
}

// ── Step 1: Add Contacts ──────────────────────────────────────────────────────

function processRawNumbers(rawText, countryCode) {
  // Split by newlines and commas
  const lines = rawText
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (lines.length === 0) return;

  const { valid, invalid } = cleanAndValidateNumbers(lines, countryCode);
  const rawContacts = valid.map((r) => ({ name: "", phone: r.phone, status: "pending", timestamp: "", notes: "" }));
  const { unique, duplicates } = deduplicateContacts(rawContacts);

  totalRawCount = lines.length;
  duplicatesRemoved = duplicates.length;
  contacts = unique;
  invalidContacts = invalid.map((r) => ({ phone: r.original, reason: r.reason }));

  renderStep1Results();
}

function renderStep1Results() {
  const validCount = contacts.length;
  const invalidCount = invalidContacts.length;

  // Stats chips
  $("statChipValid").textContent = validCount;
  $("statChipInvalid").textContent = invalidCount;
  $("statChipDupes").textContent = duplicatesRemoved;
  $("statChipTotal").textContent = validCount;
  $("statsDisplay").classList.add("visible");

  // Invalid list
  const invalidWrapper = $("invalidListWrapper");
  const invalidList = $("invalidList");
  if (invalidCount > 0) {
    invalidList.innerHTML = invalidContacts
      .slice(0, 50)
      .map(
        (c) =>
          `<div class="invalid-item">❌ ${escapeHtml(c.phone)} — ${escapeHtml(c.reason)}</div>`
      )
      .join("");
    if (invalidContacts.length > 50) {
      invalidList.innerHTML += `<div class="invalid-item">…and ${invalidContacts.length - 50} more</div>`;
    }
    invalidWrapper.style.display = "block";
  } else {
    invalidWrapper.style.display = "none";
  }

  // Contacts table
  const tableWrapper = $("contactsTableWrapper");
  const tbody = $("contactsTableBody");
  if (validCount > 0) {
    tbody.innerHTML = contacts
      .slice(0, 100)
      .map(
        (c, i) =>
          `<tr>
            <td>${i + 1}</td>
            <td>${escapeHtml(c.name || "—")}</td>
            <td>${escapeHtml(c.phone)}</td>
            <td><span class="badge badge-pending">pending</span></td>
          </tr>`
      )
      .join("");
    if (contacts.length > 100) {
      tbody.innerHTML += `<tr><td colspan="4" style="text-align:center;color:var(--color-text-muted)">…and ${contacts.length - 100} more</td></tr>`;
    }
    tableWrapper.style.display = "block";
  } else {
    tableWrapper.style.display = "none";
  }

  // Update batch warning on step 3
  updateBatchWarning();
}

function initStep1() {
  $("processBtn").addEventListener("click", () => {
    const raw = $("numberInput").value;
    const cc = $("defaultCountryCode").value;
    if (!raw.trim()) {
      alert("Please paste some phone numbers first.");
      return;
    }
    processRawNumbers(raw, cc);
  });

  // File drag and drop
  const dropZone = $("dropZone");
  const fileInput = $("fileInput");

  dropZone.addEventListener("click", () => fileInput.click());

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) handleFileUpload(fileInput.files[0]);
  });
}

async function handleFileUpload(file) {
  const cc = $("defaultCountryCode").value;
  const dropText = $("dropZone").querySelector(".drop-text");
  const original = dropText.textContent;
  dropText.textContent = "⏳ Processing…";

  try {
    const result = await readFile(file, cc);
    const { unique, duplicates } = deduplicateContacts(result.contacts);

    contacts = unique;
    duplicatesRemoved = duplicates.length;
    invalidContacts = result.invalid.map((r) => ({ phone: r.phone, reason: r.reason }));
    totalRawCount = result.contacts.length + result.invalid.length + duplicates.length;

    if (result.warnings.length > 0) {
      console.info("[WABM] File warnings:", result.warnings.join("; "));
    }

    dropText.textContent = `✅ ${file.name} (${contacts.length} contacts loaded)`;
    renderStep1Results();
  } catch (err) {
    dropText.textContent = original;
    alert(`Error reading file: ${err.message}`);
  }
}

// ── Step 2: Write Message ─────────────────────────────────────────────────────

function updateCharCount() {
  const msg = $("messageInput").value;
  const len = msg.length;
  const el = $("charCount");
  el.textContent = `${len} / 4096 characters`;
  el.className = "";
  if (len >= 1500) el.classList.add("danger");
  else if (len >= 1000) el.classList.add("warn");
}

function updateMessagePreview() {
  const template = $("messageInput").value;
  const previewEl = $("messagePreview");

  if (!template.trim()) {
    previewEl.innerHTML = `<em style="opacity:0.5">Your message preview will appear here…</em>`;
    return;
  }

  const contactName = contacts.length > 0 && contacts[0].name ? contacts[0].name : "Friend";
  const rendered = template.replace(/\{Name\}/gi, contactName);
  previewEl.textContent = rendered;
}

async function renderTemplateList() {
  const templates = await loadTemplates();
  const listEl = $("templateList");
  const names = Object.keys(templates);

  if (names.length === 0) {
    listEl.innerHTML = `<div class="empty-state">No templates saved yet.</div>`;
    return;
  }

  listEl.innerHTML = names
    .map(
      (name) =>
        `<div class="template-item" data-name="${escapeHtml(name)}">
          <span class="template-item-name">${escapeHtml(name)}</span>
          <span class="template-item-date">${formatTimestamp(templates[name].savedAt)}</span>
          <button class="btn btn-secondary btn-sm" data-action="load-template" data-name="${escapeHtml(name)}">Load</button>
          <button class="btn btn-danger btn-sm" data-action="delete-template" data-name="${escapeHtml(name)}">🗑</button>
        </div>`
    )
    .join("");

  listEl.querySelectorAll("[data-action='load-template']").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const tName = btn.dataset.name;
      const tpls = await loadTemplates();
      if (tpls[tName]) {
        $("messageInput").value = tpls[tName].message;
        updateCharCount();
        updateMessagePreview();
      }
    });
  });

  listEl.querySelectorAll("[data-action='delete-template']").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const tName = btn.dataset.name;
      if (confirm(`Delete template "${tName}"?`)) {
        await deleteTemplate(tName);
        renderTemplateList();
      }
    });
  });
}

function initStep2() {
  $("messageInput").addEventListener("input", () => {
    updateCharCount();
    updateMessagePreview();
  });

  $("saveTemplateBtn").addEventListener("click", async () => {
    const name = $("templateName").value.trim();
    const message = $("messageInput").value.trim();
    if (!name) { alert("Please enter a template name."); return; }
    if (!message) { alert("Message cannot be empty."); return; }
    await saveTemplate(name, message);
    $("templateName").value = "";
    renderTemplateList();
  });

  renderTemplateList();
}

// ── Step 3: Configure & Send ──────────────────────────────────────────────────

function updateBatchWarning() {
  const warning = $("batchWarning");
  if (contacts.length > 50) {
    warning.classList.add("visible");
  } else {
    warning.classList.remove("visible");
  }
}

function setQueueButtons(status) {
  const startBtn = $("startBtn");
  const pauseBtn = $("pauseBtn");
  const resumeBtn = $("resumeBtn");
  const stopBtn = $("stopBtn");

  startBtn.style.display = "none";
  pauseBtn.style.display = "none";
  resumeBtn.style.display = "none";
  stopBtn.style.display = "none";

  switch (status) {
    case "idle":
    case "stopped":
      startBtn.style.display = "inline-flex";
      break;
    case "running":
      pauseBtn.style.display = "inline-flex";
      stopBtn.style.display = "inline-flex";
      break;
    case "paused":
      resumeBtn.style.display = "inline-flex";
      stopBtn.style.display = "inline-flex";
      break;
  }
}

function updateProgress(data) {
  const { total = 0, sent = 0, failed = 0, skipped = 0, pending = 0 } = data;
  const done = sent + failed + skipped;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const fill = $("progressBar").querySelector(".progress-fill");
  fill.style.width = `${pct}%`;
  $("progressText").textContent =
    `${done} / ${total} processed — ${sent} sent, ${failed} failed, ${skipped} skipped`;
}

function updateLiveStatus(contactsList) {
  const el = $("liveStatusList");
  if (!contactsList || contactsList.length === 0) {
    el.innerHTML = `<div class="empty-state">Queue has not started.</div>`;
    return;
  }

  const items = contactsList
    .slice()
    .reverse()
    .slice(0, 30)
    .map(
      (c) =>
        `<div class="live-item">
          <span class="live-item-name">${escapeHtml(c.name || "—")}</span>
          <span class="live-item-phone">${escapeHtml(c.phone)}</span>
          <span class="badge badge-${c.status}">${escapeHtml(c.status)}</span>
        </div>`
    )
    .join("");

  el.innerHTML = items;
}

function initStep3() {
  updateBatchWarning();

  $("startBtn").addEventListener("click", async () => {
    if (contacts.length === 0) {
      alert("No contacts loaded. Please add contacts in Step 1 first.");
      return;
    }
    const message = $("messageInput").value.trim();
    if (!message) {
      alert("Please write a message in Step 2 first.");
      return;
    }

    const settings = {
      minDelay: parseInt($("minDelay").value, 10) || 15,
      maxDelay: parseInt($("maxDelay").value, 10) || 45,
      pauseEvery: parseInt($("pauseEvery").value, 10) || 20,
      pauseDuration: parseInt($("pauseDuration").value, 10) || 120,
    };

    await saveSettings(settings);

    try {
      const response = await chrome.runtime.sendMessage({
        type: "START_QUEUE",
        contacts,
        messageTemplate: message,
        ...settings,
      });

      if (!response || !response.ok) {
        throw new Error((response && response.error) || "Could not start queue.");
      }

      setQueueButtons("running");
    } catch (err) {
      alert(`Failed to start queue: ${err.message}`);
    }
  });

  $("pauseBtn").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "PAUSE_QUEUE" });
    setQueueButtons("paused");
  });

  $("resumeBtn").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "RESUME_QUEUE" });
    setQueueButtons("running");
  });

  $("stopBtn").addEventListener("click", async () => {
    if (!confirm("Stop the queue? Remaining contacts will be marked as skipped.")) return;
    await chrome.runtime.sendMessage({ type: "STOP_QUEUE" });
    setQueueButtons("stopped");
  });

  // Listen for status updates from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "QUEUE_STATUS_UPDATE") return;

    setQueueButtons(message.queueStatus || "idle");
    updateProgress(message);
    if (message.contacts) {
      contacts = message.contacts;
      updateLiveStatus(message.contacts);
    }

    // Extended pause notice
    const pauseNotice = $("pauseNotice");
    if (message.extendedPause) {
      $("pauseNoticeText").textContent =
        `Taking a ${message.pauseSeconds || 120}-second break to avoid spam detection…`;
      pauseNotice.classList.add("visible");
    } else {
      pauseNotice.classList.remove("visible");
    }

    if (message.queueStatus === "idle" || message.queueStatus === "stopped") {
      renderReport();
    }
  });

  // Restore queue status from background on popup open
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
    if (chrome.runtime.lastError || !response) return;
    setQueueButtons(response.queueStatus || "idle");
    updateProgress(response);
    if (response.contacts) {
      contacts = response.contacts;
      updateLiveStatus(response.contacts);
    }
  });
}

// ── Step 4: View Report ───────────────────────────────────────────────────────

function renderReport() {
  const total = contacts.length + invalidContacts.length + duplicatesRemoved;
  const valid = contacts.length;
  const sent = contacts.filter((c) => c.status === "sent").length;
  const failed = contacts.filter((c) => c.status === "failed").length;

  $("statTotal").textContent = total;
  $("statValid").textContent = valid;
  $("statDuplicates").textContent = duplicatesRemoved;
  $("statInvalid").textContent = invalidContacts.length;
  $("statSent").textContent = sent;
  $("statFailed").textContent = failed;

  const tbody = $("reportTableBody");
  if (contacts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No contacts loaded yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = contacts
    .map(
      (c, i) =>
        `<tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(c.name || "—")}</td>
          <td>${escapeHtml(c.phone)}</td>
          <td><span class="badge badge-${escapeHtml(c.status)}">${escapeHtml(c.status)}</span></td>
          <td>${escapeHtml(formatTimestamp(c.timestamp))}</td>
          <td title="${escapeHtml(c.notes || "")}" style="max-width:100px;">${escapeHtml((c.notes || "").slice(0, 40))}</td>
        </tr>`
    )
    .join("");
}

function initStep4() {
  $("exportXlsxBtn").addEventListener("click", () => {
    if (contacts.length === 0) { alert("No contacts to export."); return; }
    try {
      exportToXlsx(contacts, `whatsapp_report_${Date.now()}`);
    } catch (err) {
      alert(`Export failed: ${err.message}`);
    }
  });

  $("exportCsvBtn").addEventListener("click", () => {
    if (contacts.length === 0) { alert("No contacts to export."); return; }
    try {
      exportToCsv(contacts, `whatsapp_report_${Date.now()}`);
    } catch (err) {
      alert(`Export failed: ${err.message}`);
    }
  });
}

// ── Initialization ────────────────────────────────────────────────────────────

async function init() {
  initNavigation();
  initStep1();
  initStep2();
  initStep3();
  initStep4();

  // Restore settings
  try {
    const settings = await loadSettings();
    $("defaultCountryCode").value = settings.defaultCountryCode || "91";
    $("minDelay").value = settings.minDelay ?? 15;
    $("maxDelay").value = settings.maxDelay ?? 45;
    $("pauseEvery").value = settings.pauseEvery ?? 20;
    $("pauseDuration").value = settings.pauseDuration ?? 120;
  } catch (_) {
    // Ignore storage errors on init
  }

  // Load templates
  await renderTemplateList();

  // Initial char count
  updateCharCount();
}

document.addEventListener("DOMContentLoaded", init);
