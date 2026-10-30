const root = document.documentElement;
const editor = document.querySelector("[data-editor]");
const editorGutter = document.querySelector("[data-editor-gutter]");
const toast = document.querySelector("[data-toast]");
const files = {
  "firmware.ino": `// ForgeLab source context: generic 16-bit I/O spectroscopy board
// Originals are read-only. Drafts are generated separately.

const uint8_t PORT_A_LATCH = 7;
const uint8_t PORT_B_LATCH = 8;
const uint8_t INPUT_CLOCK = 9;

void setup() {
  Serial.begin(9600);
  pinMode(PORT_A_LATCH, OUTPUT);
  pinMode(PORT_B_LATCH, OUTPUT);
  pinMode(INPUT_CLOCK, OUTPUT);
  safeState();
}

void loop() {
  if (Serial.available()) {
    handleCommand(Serial.readStringUntil('\\n'));
  }
}

void safeState() {
  writeOutputs(0x0000);
}`,
  "hal_mcu.h": `#pragma once

// Generic 16-bit I/O hardware contract.
struct BoardProfile {
  const char* name;
  uint32_t baud;
  uint16_t outputBits;
  uint16_t inputBits;
};

constexpr BoardProfile ATMEGA2560_PROFILE{
  "generic-16bit-io", 9600, 16, 12
};`,
  "sequence_engine.cpp": `#include "hal_mcu.h"

void writeOutputs(uint16_t value) {
  // Reviewable hardware boundary. No implicit writes.
  writePortA(static_cast<uint8_t>(value & 0xFF));
  writePortB(static_cast<uint8_t>((value >> 8) & 0xFF));
}`,
  "instrument_config.json": `{
  "board": "generic-16bit-io",
  "baud": 9600,
  "simulation": true,
  "source_firmware": "firmware.ino",
  "draft_policy": "never-overwrite-source"
}`,
  "calibration.csv": `channel,raw,expected
0,511,2.4947
1,508,2.4801
2,508,2.4801`,
  "run-notes.pdf": "[PDF preview] Calibration notes and instrument context loaded."
};

let activeFile = "firmware.ino";
let openFiles = ["firmware.ino"];
const API_BASE = window.location.protocol === "file:" ? "http://127.0.0.1:8765" : "";
const savedTheme = localStorage.getItem("forgelab-theme");
if (savedTheme) root.dataset.theme = savedTheme;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function highlightCode(text) {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.split("\n").map((line) => `<span class="code-line">${line || " "}</span>`).join("");
}

function renderEditor() {
  editor.value = files[activeFile] || "// Uploaded file ready for inspection.";
  updateEditorGutter();
  renderEditorTabs();
  document.querySelector("[data-editor-state]").textContent = activeFile === "firmware.ino" ? "Editable initial config" : "Editable context file";
}
function updateEditorGutter() {
  const lineCount = Math.max(1, editor.value.split("\n").length);
  editorGutter.textContent = Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
}
function renderEditorTabs() {
  const tabs = document.querySelector("[data-editor-tabs]");
  const path = tabs.querySelector(".editor-path");
  const runButton = tabs.querySelector(".run-button");
  tabs.replaceChildren();
  openFiles.forEach((name) => {
    const tab = document.createElement("div");
    tab.className = `editor-tab${name === activeFile ? " is-active" : ""}`;
    tab.innerHTML = `<button type="button" class="editor-tab-main"><span class="file-icon ${iconClass(name)}">${name.split(".").pop().toUpperCase()}</span><span>${name}</span></button><button type="button" class="editor-tab-close" aria-label="Close ${name}" data-close-file="${name}">×</button>`;
    tab.querySelector(".editor-tab-main").addEventListener("click", () => {
      activeFile = name;
      renderEditor();
    });
    tab.querySelector(".editor-tab-close").addEventListener("click", () => closeEditor(name));
    tabs.append(tab);
  });
  tabs.append(path, runButton);
}
function closeEditor(name) {
  if (openFiles.length === 1) {
    showToast("Keep one editor open to preserve the workspace.");
    return;
  }
  const closingIndex = openFiles.indexOf(name);
  openFiles = openFiles.filter((file) => file !== name);
  if (activeFile === name) activeFile = openFiles[Math.max(0, closingIndex - 1)];
  renderEditor();
}
function bindFileRow(button) {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-file]").forEach((item) => item.classList.toggle("is-active", item === button));
    loadFile(button.dataset.file);
  });
}

function iconClass(name) {
  const extension = name.split(".").pop().toLowerCase();
  return { ino: "ino", h: "h", cpp: "cpp", json: "json", csv: "csv", pdf: "pdf", md: "md" }[extension] || "json";
}

function renderFileTree(fileList) {
  const tree = document.querySelector("[data-file-tree]");
  tree.replaceChildren();
  fileList.forEach((file, index) => {
    const row = document.createElement("button");
    row.className = `file-row${index === 0 ? " is-active" : ""}`;
    row.dataset.file = file.name;
    row.innerHTML = `<span class="file-icon ${iconClass(file.name)}">${file.name.split(".").pop().toUpperCase()}</span><span>${file.name}</span><span class="source-tag">${file.readOnly ? "source" : "upload"}</span>`;
    bindFileRow(row);
    tree.append(row);
  });
  document.querySelector("[data-file-count]").textContent = `${fileList.length} files`;
  document.querySelector("[data-context-count]").textContent = `${fileList.length} files`;
}

async function loadWorkspace() {
  try {
    const response = await fetch(`${API_BASE}/api/workspace`);
    if (!response.ok) throw new Error(`Workspace returned ${response.status}`);
    const data = await response.json();
    renderFileTree(data.files);
    await loadFile("firmware.ino");
  } catch (error) {
    const fallback = Object.keys(files).map((name) => ({ name, readOnly: true }));
    renderFileTree(fallback);
    showToast(`Local server unavailable. Using browser context. ${error.message}`);
  }
}

async function loadFile(name) {
  const savedDraft = localStorage.getItem(`forgelab-draft:${name}`);
  if (savedDraft !== null) {
    files[name] = savedDraft;
    activeFile = name;
    if (!openFiles.includes(name)) openFiles.push(name);
    renderEditor();
    return;
  }
  if (files[name] && files[name].startsWith("[Uploaded context:")) {
    activeFile = name;
    if (!openFiles.includes(name)) openFiles.push(name);
    renderEditor();
    return;
  }
  try {
    const response = await fetch(`${API_BASE}/api/file/${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`File returned ${response.status}`);
    const data = await response.json();
    files[name] = data.content;
  } catch (error) {
    if (!files[name]) files[name] = `// Could not load ${name}: ${error.message}`;
  }
  activeFile = name;
  if (!openFiles.includes(name)) openFiles.push(name);
  renderEditor();
}

renderEditor();
loadWorkspace();

editor.addEventListener("input", () => {
  files[activeFile] = editor.value;
  localStorage.setItem(`forgelab-draft:${activeFile}`, files[activeFile]);
  updateEditorGutter();
  document.querySelector("[data-editor-state]").textContent = "Unsaved user draft";
});
editor.addEventListener("scroll", () => {
  editorGutter.scrollTop = editor.scrollTop;
});
editor.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.setRangeText("  ", start, end, "end");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    document.querySelector("[data-save-draft]").click();
  }
});

document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
  const theme = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = theme;
  localStorage.setItem("forgelab-theme", theme);
});

const uploadInput = document.querySelector("#file-upload");
document.querySelectorAll("[data-upload-trigger]").forEach((trigger) => trigger.addEventListener("click", () => uploadInput.click()));
uploadInput.addEventListener("change", () => {
  [...uploadInput.files].forEach((file) => {
    files[file.name] = `[Uploaded context: ${file.name}]`;
    const row = document.createElement("button");
    row.className = "file-row";
    row.dataset.file = file.name;
    row.innerHTML = `<span class="file-icon json">FILE</span><span>${file.name}</span><span class="source-tag">upload</span>`;
    bindFileRow(row);
    document.querySelector("[data-file-tree]").append(row);
    const reader = new FileReader();
    reader.onload = async () => {
      files[file.name] = String(reader.result);
      if (window.location.protocol !== "file:") {
        try {
          await fetch(`${API_BASE}/api/upload`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: file.name, content: files[file.name] }),
          });
        } catch (error) {
          showToast(`Upload kept in browser context: ${error.message}`);
        }
      }
      loadFile(file.name);
    };
    reader.readAsText(file);
  });
  const count = document.querySelectorAll("[data-file]").length;
  document.querySelector("[data-file-count]").textContent = `${count} files`;
  document.querySelector("[data-context-count]").textContent = `${count} files`;
  showToast(`${uploadInput.files.length} file${uploadInput.files.length === 1 ? "" : "s"} added to local context.`);
});

document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelector("[data-agent-input]").value = button.dataset.prompt;
    document.querySelector("[data-agent-input]").focus();
  });
});

const replies = (prompt) => {
  const lower = prompt.toLowerCase();
  if (lower.includes("generate") || lower.includes("artifact")) return "I mapped the loaded firmware and created a reviewable artifact draft. It is listed below the editor and does not replace the source file.";
  if (lower.includes("pwm") || lower.includes("sequence")) return "I would draft CONFIG 9 PWM, W 9 160, DLY 150, then W 9 0 for a simulation first. Confirm the channel mapping before a hardware review.";
  if (lower.includes("map") || lower.includes("output")) return "The generic profile exposes 16 output bits across two latched ports. The current source writes the low byte to Port A and the high byte to Port B.";
  return "I inspected the current context. I can explain the firmware, propose a safe patch, or generate a separate artifact. Source files remain unchanged.";
};

document.querySelector("[data-agent-form]").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("[data-agent-input]");
  const prompt = input.value.trim();
  if (!prompt) return;
  const thread = document.querySelector("[data-agent-thread]");
  const user = document.createElement("div");
  user.className = "agent-message";
  const userMeta = document.createElement("span");
  userMeta.className = "message-meta";
  userMeta.innerHTML = "You <time>now</time>";
  const userText = document.createElement("p");
  userText.textContent = prompt;
  user.append(userMeta, userText);
  thread.append(user);
  input.value = "";
  input.disabled = true;
  const sendButton = document.querySelector(".send-button");
  sendButton.disabled = true;
  sendButton.textContent = "…";
  const thinking = document.createElement("div");
  thinking.className = "agent-message agent-thinking";
  thinking.innerHTML = '<span class="message-meta">ForgeLab <time>working</time></span><p>Inspecting the loaded context and preparing a reviewable response...</p>';
  thread.append(thinking);
  thread.scrollTop = thread.scrollHeight;
  const respond = async () => {
    thinking.remove();
    const reply = document.createElement("div");
    reply.className = "agent-message";
    const replyMeta = document.createElement("span");
    replyMeta.className = "message-meta";
    replyMeta.innerHTML = "ForgeLab <time>now</time>";
    const replyText = document.createElement("p");
    let responseText = replies(prompt);
    try {
      const response = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, conversation: [], provider: "ollama" }),
      });
      if (!response.ok) throw new Error((await response.json()).error || `Agent returned ${response.status}`);
      const data = await response.json();
      responseText = data.message || responseText;
      if (data.artifact) showToast(`Generated ${data.artifact.filename} as a reviewable draft.`);
    } catch (error) {
      if (window.location.protocol !== "file:") responseText = `Agent unavailable: ${error.message}`;
    }
    replyText.textContent = responseText;
    reply.append(replyMeta, replyText);
    thread.append(reply);
    thread.scrollTop = thread.scrollHeight;
    input.disabled = false;
    sendButton.disabled = false;
    sendButton.textContent = "↗";
    input.focus();
    showToast("Draft response added to the agent activity.");
  };
  window.setTimeout(respond, 380);
});

document.querySelector("[data-save-draft]").addEventListener("click", () => {
  files[activeFile] = editor.value;
  localStorage.setItem(`forgelab-draft:${activeFile}`, files[activeFile]);
  document.querySelector("[data-editor-state]").textContent = "Saved user draft";
  showToast(`${activeFile} saved locally. Source file is unchanged.`);
});
document.querySelector("[data-format-draft]").addEventListener("click", () => showToast("Formatting preview ready. Apply it only to a draft."));
document.querySelector("[data-run-draft]").addEventListener("click", () => showToast("Simulation queued. No hardware connection is used in this browser demo."));

const auth = document.querySelector(".auth-dialog");
document.querySelector("[data-open-auth]").addEventListener("click", () => auth.showModal());
document.querySelector("[data-close-auth]").addEventListener("click", () => auth.close());
document.querySelector("[data-auth-form]").addEventListener("submit", (event) => {
  event.preventDefault();
  document.querySelector("[data-auth-status]").textContent = "Prototype mode: one-time code state created. No message was sent.";
});
