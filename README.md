# WhatsApp Bulk Messenger

A free, lightweight Chrome/Edge Extension that lets you send personalised WhatsApp messages to multiple contacts **safely and sequentially** — using only the official `wa.me` chat-link mechanism. No unofficial APIs, no DOM scraping, no risk of banning.

---

## Features

| Module | What it does |
|--------|-------------|
| **Contact Input** | Paste numbers in any format **or** upload `.xlsx` / `.csv` — auto-detects the phone & name columns |
| **Message Composer** | Write a message with `{Name}` personalisation, live preview, character counter, and 5 saved templates |
| **Safe Sending** | Opens each `wa.me` link one at a time, waits for WhatsApp Web to load, clicks Send, then waits a random delay (15–45 s by default) |
| **Spam Protection** | Deduplication, E.164 validation, batch-size warning (>50), daily-limit advisory (>100), extended pause every N messages |
| **Report Dashboard** | Per-contact status table (sent / failed / skipped) with export to `.xlsx` and `.csv` |
| **Privacy** | 100 % client-side — no server, no analytics, no data leaves your device |

---

## Installation

### Step 1 — Download SheetJS (required for Excel/CSV and export)

Chrome Manifest V3 extensions cannot load scripts from remote CDNs, so SheetJS must be bundled locally.

```bash
curl -o extension/lib/xlsx.full.min.js \
  https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
```

Or download it manually from the [SheetJS GitHub releases](https://github.com/SheetJS/sheetjs/releases/tag/v0.18.5) and place the file at `extension/lib/xlsx.full.min.js`.

### Step 2 — Load the extension in Chrome/Edge (Developer Mode)

1. Open Chrome and navigate to `chrome://extensions` (or `edge://extensions` for Edge).
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the `extension/` folder inside this repository.
5. The **WhatsApp Bulk Messenger** icon appears in your toolbar.

> **Tip:** Pin the extension from the Extensions menu so it is always one click away.

---

## Usage Walkthrough

### Step 1 — Add Contacts

- **Paste numbers**: Drop phone numbers (one per line or comma-separated) into the textarea. Supported formats:
  ```
  9876543210
  +91 98765 43211
  +1-800-555-0199
  (987) 654-3212
  ```
- **Upload a file**: Drag and drop an `.xlsx` or `.csv` file. The extension auto-detects the phone column (by header keywords: *phone, mobile, number, contact, whatsapp, tel*) and the name column (*name, fullname, first name*).
- Choose a **default country code** (default: 🇮🇳 +91 India) for numbers without a country prefix.
- Click **✅ Process Numbers** to clean, validate, and deduplicate.
- Invalid numbers are listed separately for your review.

### Step 2 — Write Message

- Compose your message in the textarea.
- Use `{Name}` to insert the contact's name (falls back to "Friend" if no name is available).
- The **live preview** panel shows exactly how the message will look for your first contact.
- The **character counter** warns at 1,000 characters (WhatsApp URL-encoding limit).
- Save up to **5 named templates** for reuse.

### Step 3 — Configure & Send

| Setting | Default | Description |
|---------|---------|-------------|
| Min delay | 15 s | Minimum wait between messages |
| Max delay | 45 s | Maximum wait between messages |
| Pause every N | 20 | Take a longer break after this many sends |
| Pause duration | 120 s | Length of the extended break |

Click **▶ Start Sending**. For each contact the extension:
1. Opens `https://wa.me/<number>?text=<message>` in a background tab.
2. Waits for WhatsApp Web to load and the Send button to appear (up to 30 s).
3. Clicks the Send button.
4. Closes the tab and waits the random delay before the next contact.

Use **⏸ Pause**, **▶ Resume**, or **⏹ Stop** at any time.

### Step 4 — View Report

After the session a summary is shown:

| Metric | Description |
|--------|-------------|
| Total contacts loaded | Raw count before processing |
| Valid numbers | Passed cleaning and validation |
| Duplicates removed | Filtered out automatically |
| Invalid numbers skipped | Failed validation |
| Messages sent | Chat opened + Send clicked |
| Failed / skipped | Timeout, tab error, or user-cancelled |

Export the full log as **XLSX** or **CSV** (Name, Phone, Status, Timestamp, Notes columns).

---

## Technical Architecture

```
extension/
├── manifest.json          Manifest V3
├── popup.html             Main UI entry point
├── popup.js               UI controller (ES module)
├── background.js          Service worker — tab & queue management
├── content.js             Injected into web.whatsapp.com — clicks Send
├── utils/
│   ├── parser.js          Number cleaning, E.164 validation, dedup
│   ├── excelReader.js     SheetJS xlsx/csv parser with column auto-detection
│   ├── excelWriter.js     SheetJS report export (xlsx + csv)
│   ├── queue.js           QueueManager class with event emitter
│   └── storage.js         chrome.storage.local wrapper
├── styles/
│   └── popup.css          WhatsApp green theme + dark mode
└── lib/
    └── xlsx.full.min.js   SheetJS (must be downloaded — see Installation)
```

**Key libraries:**

| Library | Purpose |
|---------|---------|
| [SheetJS (xlsx)](https://sheetjs.com/) | Read `.xlsx` / `.csv`, write export reports |
| Chrome Extension APIs | `chrome.tabs`, `chrome.storage`, `chrome.scripting` |

**Manifest V3 permissions:**
```json
{
  "permissions": ["tabs", "storage", "scripting", "activeTab"],
  "host_permissions": ["https://wa.me/*", "https://web.whatsapp.com/*"]
}
```

---

## Limitations & WhatsApp Fair-Use Guidance

- **This tool uses only the official `wa.me` link mechanism.** It does **not** use the WhatsApp Business API, unofficial libraries (e.g. whatsapp-web.js, Baileys), or read/write your WhatsApp session.
- WhatsApp monitors for unusual send patterns. To reduce risk:
  - Keep batches under **50 contacts per session**.
  - Do not send to more than **100 contacts per day**.
  - Use realistic delays (15–45 s minimum).
  - Enable the extended-pause feature.
- This is a **personal automation tool** — do not use it for commercial spam or unsolicited bulk messaging.
- The authors are not responsible for any account restrictions resulting from misuse.

---

## Privacy

- All contact data, messages, and reports are stored exclusively in `chrome.storage.local` on your device.
- No data is sent to any server or third party.
- Uninstalling the extension automatically clears all stored data.

---

## License

[MIT](LICENSE)
