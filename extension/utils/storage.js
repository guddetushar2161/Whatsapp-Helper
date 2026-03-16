/**
 * chrome.storage.local wrapper utilities
 */

const TEMPLATES_KEY = "wabm_templates";
const SETTINGS_KEY = "wabm_settings";

export function get(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result[key]);
      }
    });
  });
}

export function set(key, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

export function remove(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(key, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

export function clear() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.clear(() => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Save a message template
 * @param {string} name - Template name
 * @param {string} message - Template message body
 */
export async function saveTemplate(name, message) {
  const templates = await loadTemplates();
  templates[name] = { message, savedAt: new Date().toISOString() };
  await set(TEMPLATES_KEY, templates);
}

/**
 * Load all saved templates
 * @returns {Promise<Record<string, { message: string, savedAt: string }>>}
 */
export async function loadTemplates() {
  const templates = await get(TEMPLATES_KEY);
  return templates || {};
}

/**
 * Delete a named template
 * @param {string} name
 */
export async function deleteTemplate(name) {
  const templates = await loadTemplates();
  delete templates[name];
  await set(TEMPLATES_KEY, templates);
}

const DEFAULT_SETTINGS = {
  defaultCountryCode: "91",
  minDelay: 15,
  maxDelay: 45,
  pauseEvery: 20,
  pauseDuration: 120,
};

/**
 * Save settings object
 * @param {object} settings
 */
export async function saveSettings(settings) {
  await set(SETTINGS_KEY, { ...DEFAULT_SETTINGS, ...settings });
}

/**
 * Load settings, falling back to defaults
 * @returns {Promise<object>}
 */
export async function loadSettings() {
  const settings = await get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
