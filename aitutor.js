let documentMode = false;
let uploadedText = "";
const $ = (id) => document.getElementById(id);

const SYSTEM_PROMPT = `
You are a live interview assistant.

Rules:
- Answer naturally and professionally.
- If the question is theoretical, answer in plain English.
- If the question requires code, provide the complete code.
- Use Markdown code blocks.
- Always specify the language.

Example:
\`\`\`java
public class Main {
    public static void main(String[] args) {
        System.out.println("Hello");
    }
}
\`\`\`

Keep explanations concise.
`;

/* ---- Storage with memory fallback ---- */
const mem = {};

function store(k, v) {
  mem[k] = v;
  const expires = Date.now() + 4 * 60 * 60 * 1000;
  try {
    localStorage.setItem(
      k,
      JSON.stringify({ value: v, expires: expires })
    );
  } catch (e) {
    console.warn("LocalStorage unavailable, falling back to memory store.", e);
  }
}

function load(k) {
  if (mem[k]) return mem[k];
  try {
    const item = localStorage.getItem(k);
    if (!item) return "";
    const data = JSON.parse(item);
    if (Date.now() > data.expires) {
      localStorage.removeItem(k);
      return "";
    }
    return data.value;
  } catch {
    return "";
  }
}

const K_GEMINI = "ai_tp_key_gemini";
const K_GROQ = "ai_tp_key_groq";
const K_PROVIDER = "ai_tp_provider";

function provider() {
  return load(K_PROVIDER) || "gemini";
}

function keyFor(p) {
  return (load(p === "groq" ? K_GROQ : K_GEMINI) || "").trim();
}

let rec = null;
let listening = false;
let manualStop = false;
let scrolling = false;
let raf = 0;
let lastQuestion = "";
let countdown = null;
let speechDebounceTimer = null;

function setStatus(t) {
  const el = $("status");
  if (el) el.textContent = t;
}

function setError(t) {
  const el = $("error");
  if (!el) return;
  el.textContent = t || "";
  el.classList.toggle("hidden", !t);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderResponse(text) {
  const view = $("view");
  if (!view) return; //

  const codeRegex = /```(\w+)?\n([\s\S]*?)```/g;

  if (codeRegex.test(text)) {
    codeRegex.lastIndex = 0; //
    
    // Injects a Copy button alongside the language label inside the code-header
    view.innerHTML = text.replace(
      codeRegex,
      (match, language, code) => `
        <div class="code-box">
          <div class="code-header">
            <span>${language || "text"}</span>
            <button class="copy-code-btn" type="button" onclick="copyToClipboard(this)">📋 Copy</button>
          </div>
          <pre><code>${escapeHtml(code)}</code></pre>
        </div>
      `
    );
  } else {
    view.textContent = text; //
  }
}
/* ---- Clipboard Copy Management ---- */
function copyToClipboard(buttonElement) {
  // Traverses the DOM to grab the code string directly inside the adjacent <pre><code> block
  const codeBlock = buttonElement.closest('.code-box').querySelector('pre code');
  if (!codeBlock) return;

  const textToCopy = codeBlock.textContent;

  navigator.clipboard.writeText(textToCopy).then(() => {
    // Visual feedback switch
    buttonElement.textContent = "✅ Copied!";
    buttonElement.style.color = "var(--primary)";
    
    // Revert back after 2 seconds
    setTimeout(() => {
      buttonElement.textContent = "📋 Copy";
      buttonElement.style.color = "";
    }, 200);
  }).catch(() => {
    buttonElement.textContent = "❌ Failed";
  });
}

/* ---- Key Expiry Timer Management ---- */
function updateTimer() {
  const timerEl = $("keyTimer");
  if (!timerEl) return;

  const p = provider();
  const key = p === "groq" ? K_GROQ : K_GEMINI;
  let raw = null;

  try {
    raw = localStorage.getItem(key);
  } catch (e) {}

  if (!raw && !mem[key]) {
    timerEl.textContent = "No Active Session";
    return;
  }

  let expires = 0;
  if (raw) {
    try {
      expires = JSON.parse(raw).expires;
    } catch (e) {}
  }

  const left = expires - Date.now();

  if (left <= 0) {
    try {
      localStorage.removeItem(key);
    } catch (e) {}
    delete mem[key];
    timerEl.textContent = "Expired";
    return;
  }

  const h = Math.floor(left / 3600000);
  const m = Math.floor((left % 3600000) / 60000);
  const s = Math.floor((left % 60000) / 1000);

  timerEl.textContent = `Expires in ${h}h ${m}m ${s}s`;
}

function startTimer() {
  if (countdown) clearInterval(countdown);
  updateTimer();
  countdown = setInterval(updateTimer, 1000);
}

/* ---- AI Response Generation ---- */
async function generate(question) {
  const q = (question || "").trim();
  if (!q) return setError("Nothing heard yet — say a question first.");

  const p = provider();
  const key = keyFor(p);

  if (!key) {
    openSettings();
    return setError("Add your " + (p === "groq" ? "Groq" : "Gemini") + " API key in Settings.");
  }

  lastQuestion = q;
  setError("");
  setStatus("Thinking…");

  const viewEl = $("view");
  if (viewEl) viewEl.textContent = "";

  try {
    let text = "";
    if (p === "gemini") {
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" +
          encodeURIComponent(key),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: "user", parts: [{ text: q }] }],
          }),
        }
      );
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error?.message || "Gemini error " + res.status);
      text = (j.candidates?.[0]?.content?.parts || []).map((x) => x.text).join("");
    } else {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: q },
          ],
          temperature: 0.8,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error?.message || "Groq error " + res.status);
      text = j.choices?.[0]?.message?.content || "";
    }

    if (viewEl) {
      renderResponse(text.trim() || "(empty answer)");
      viewEl.scrollTop = 0;
    }
    setStatus("Answer ready");
    startScroll(true);
  } catch (e) {
    setError(e.message || "Request failed");
    setStatus("Error");
  }
}

/* ---- Speech Recognition Setup ---- */
function startListening() {
  if (documentMode) {
    setError("Document mode is active.");
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return setError("Speech recognition not supported. Use Google Chrome.");
  if (location.protocol === "file:") {
    setError("Microphone needs http:// — run a local server (e.g., python -m http.server 8000) instead of opening directly.");
  }

  try {
    if (rec) rec.abort();
  } catch (e) {}

  rec = new SR();
  rec.lang = "en-IN";
  rec.continuous = true;
  rec.interimResults = true;
  manualStop = false;

  rec.onstart = () => {
    listening = true;
    if ($("dot")) $("dot").classList.add("live");
    if ($("startBtn")) $("startBtn").textContent = "Stop Listening";
    setStatus("Listening…");
    setError("");
  };

  rec.onerror = (ev) => {
    if (ev.error !== "no-speech") setError("Mic error: " + ev.error);
  };

  rec.onend = () => {
    listening = false;
    if ($("dot")) $("dot").classList.remove("live");
    if ($("startBtn")) $("startBtn").textContent = "Start Listening";

    if (!manualStop) {
      setStatus("Reconnecting mic…");
      setTimeout(() => {
        try {
          rec.start();
        } catch (e) {}
      }, 400);
    } else {
      setStatus("Stopped");
    }
  };

  rec.onresult = (ev) => {
    let interim = "", final = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }

    const heardText = (final || interim).trim();
    if ($("heard")) $("heard").textContent = heardText || "—";

    if (final.trim()) {
      clearTimeout(speechDebounceTimer);
      speechDebounceTimer = setTimeout(() => {
        generate(final.trim());
      }, 1200);
    }
  };

  try {
    rec.start();
  } catch (e) {}
}

function stopListening() {
  manualStop = true;
  clearTimeout(speechDebounceTimer);
  try {
    if (rec) rec.stop();
  } catch (e) {}
  listening = false;
  if ($("dot")) $("dot").classList.remove("live");
  if ($("startBtn")) $("startBtn").textContent = "Start Listening";
  setStatus("Stopped");
}

function loadDocument(file) {
  if (!file) return;

  const reader = new FileReader();

  reader.onload = function (event) {
    uploadedText = event.target.result;
    documentMode = true;
    stopListening();

    const view = $("view");
    if (view) {
      view.textContent = uploadedText;
      view.scrollTop = 0;
    }

    if ($("heard")) {
      $("heard").textContent = uploadedText.length + " characters loaded";
    }

    setStatus("Document loaded");
    startScroll(true);
  };

  reader.onerror = function () {
    setError("Unable to read the document.");
  };

  reader.readAsText(file);
}

/* ---- Teleprompter Smooth Auto-Scroll ---- */
function startScroll(on) {
  scrolling = on === undefined ? !scrolling : on;
  if ($("scrollBtn")) $("scrollBtn").textContent = scrolling ? "Pause Scroll" : "Start Scroll";

  cancelAnimationFrame(raf);
  if (!scrolling) return;

  let last = performance.now();
  const step = (t) => {
    const el = $("view");
    const speedEl = $("speed");
    if (el && speedEl) {
      const dt = (t - last) / 1000;
      last = t;
      el.scrollTop += Number(speedEl.value) * dt;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
        return startScroll(false);
      }
    }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}

/* ---- Settings & Configuration Panel ---- */
function openSettings() {
  if ($("geminiKey")) $("geminiKey").value = load(K_GEMINI) || "";
  if ($("groqKey")) $("groqKey").value = load(K_GROQ) || "";
  if ($("provider")) $("provider").value = provider();

  startTimer();
  if ($("saveMsg")) $("saveMsg").textContent = "";
  if ($("settings")) $("settings").classList.remove("hidden");
}

function saveSettings() {
  if ($("geminiKey")) store(K_GEMINI, $("geminiKey").value.trim());
  if ($("groqKey")) store(K_GROQ, $("groqKey").value.trim());
  if ($("provider")) store(K_PROVIDER, $("provider").value);

  updateTimer();
  setStatus("API Key Saved");
  if ($("saveMsg")) $("saveMsg").textContent = "✅ Saved Successfully";
}

/* ---- Initialization & Event Bindings ---- */
window.addEventListener("DOMContentLoaded", () => {
  startTimer();

  // 1. Microphone Start / Stop Toggle
  if ($("startBtn")) {
    $("startBtn").onclick = () => {
      if (!listening) {
        startListening();
      } else {
        stopListening();
      }
    };
  }

  // 2. Restart Button
  if ($("restartBtn")) {
    $("restartBtn").onclick = () => {
      stopListening();
      setTimeout(startListening, 300);
    };
  }

  // 3. Generate Again Button
  if ($("againBtn")) {
    $("againBtn").onclick = () => {
      const textToGenerate = lastQuestion || ($("heard") ? $("heard").textContent : "");
      if (textToGenerate && textToGenerate !== "—") {
        generate(textToGenerate);
      } else {
        setError("Say a question first!");
      }
    };
  }

  // 4. Scroll Control Button
  if ($("scrollBtn")) {
    $("scrollBtn").onclick = () => startScroll();
  }

  // 5. Rewind Scroll Button
  if ($("rewindBtn")) {
    $("rewindBtn").onclick = () => {
      if ($("view")) $("view").scrollTop = 0;
    };
  }

  // 6. Clear Display Button
  if ($("clearBtn")) {
    $("clearBtn").onclick = () => {
      if ($("view")) $("view").textContent = "Waiting...";
      if ($("heard")) $("heard").textContent = "—";
      startScroll(false);
      setStatus("Cleared");
    };
  }

  // 7. Document Mode Controls
  if ($("documentBtn") && $("documentFile")) {
    $("documentBtn").onclick = () => $("documentFile").click();
    $("documentFile").onchange = (e) => {
      if (e.target.files && e.target.files[0]) {
        loadDocument(e.target.files[0]);
      }
    };
  }

  if ($("stopDocumentBtn")) {
    $("stopDocumentBtn").onclick = () => {
      documentMode = false;
      uploadedText = "";
      if ($("view")) $("view").textContent = "Waiting...";
      if ($("heard")) $("heard").textContent = "—";
      setStatus("Voice mode enabled");
    };
  }

  // 8. Fullscreen Toggle Button
  if ($("fullscreenBtn")) {
    $("fullscreenBtn").onclick = () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    };
  }

  // 9. Text-to-Speech Controls
  if ($("speakBtn")) {
    $("speakBtn").onclick = () => {
      const text = $("view") ? $("view").textContent : "";
      if (!text || text === "Waiting..." || text === "(empty answer)") return;
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    };
  }

  if ($("muteBtn")) {
    $("muteBtn").onclick = () => speechSynthesis.cancel();
  }

  // 10. Settings Modal Handlers
  if ($("settingsBtn")) $("settingsBtn").onclick = openSettings;
  if ($("closeBtn")) $("closeBtn").onclick = () => $("settings").classList.add("hidden");

  if ($("saveBtn")) {
    $("saveBtn").onclick = async () => {
      saveSettings();
      await new Promise((r) => setTimeout(r, 1200));
      if ($("settings")) $("settings").classList.add("hidden");
    };
  }

  if ($("provider")) {
    $("provider").onchange = () => {
      store(K_PROVIDER, $("provider").value);
      updateTimer();
    };
  }

  // 11. Sliders for Speed & Font Size
  if ($("speed")) {
    $("speed").oninput = () => {
      if ($("speedVal")) $("speedVal").textContent = $("speed").value;
    };
  }

  if ($("font")) {
    $("font").oninput = () => {
      if ($("fontVal")) $("fontVal").textContent = $("font").value;
      if ($("view")) $("view").style.fontSize = $("font").value + "px";
    };
  }

  // 12. Initial Key Inputs Setup
  if ($("geminiKey")) $("geminiKey").value = load(K_GEMINI) || "";
  if ($("groqKey")) $("groqKey").value = load(K_GROQ) || "";
  if ($("provider")) $("provider").value = provider();

  if ($("showGemini")) {
    $("showGemini").onclick = () => {
      const input = $("geminiKey");
      if (input) input.type = input.type === "password" ? "text" : "password";
    };
  }

  if ($("showGroq")) {
    $("showGroq").onclick = () => {
      const input = $("groqKey");
      if (input) input.type = input.type === "password" ? "text" : "password";
    };
  }

  if (!keyFor(provider())) {
    openSettings();
  }
});