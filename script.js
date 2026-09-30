(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const API = location.protocol === "file:" ? "http://localhost:8787" : "";
  const els = {
    text: $("textInput"), voice: $("voiceSelect"), language: $("languageSelect"), rate: $("rateRange"),
    pitch: $("pitchRange"), volume: $("volumeRange"), rateValue: $("rateValue"), pitchValue: $("pitchValue"),
    volumeValue: $("volumeValue"), words: $("wordCount"), chars: $("characterCount"), status: $("statusText"),
    dot: $("statusDot"), chunk: $("chunkLabel"), percent: $("percentage"), fill: $("progressFill"),
    play: $("playButton"), playIcon: $("playIcon"), stop: $("stopButton"), restart: $("restartButton"),
    previous: $("previousButton"), next: $("nextButton"), note: $("supportNote"), toast: $("toast"),
    title: $("documentTitle"), playbackTitle: $("playbackTitle"), playbackDetail: $("playbackDetail"),
    generate: $("generateAudio"), audioPanel: $("audioPanel"), audio: $("audioPlayer"), audioStatus: $("audioStatus"),
    downloadWav: $("downloadWav"), downloadMp3: $("downloadMp3"), audioDuration: $("audioDuration"),
    audioFormat: $("audioFormat"), batchInput: $("batchFileInput"), batchList: $("batchList"),
    generateAll: $("generateAll"), downloadAll: $("downloadAll"), batchProgress: $("batchProgress"),
    batchStatus: $("batchStatus"), batchPercentage: $("batchPercentage"), batchFill: $("batchFill"),
    diagnostics: $("diagnosticsGrid"), library: $("libraryPanel"), exitReading: $("exitReadingMode")
  };
  let generated = null, chunks = [], currentChunk = 0, batchDocuments = [], batchResults = [];
  const legacySaved = JSON.parse(localStorage.getItem("vocalisSaved") || "[]");
  let savedTexts = JSON.parse(localStorage.getItem("vocalisSavedDocuments") || "null") || legacySaved.map((document) => ({
    id: document.id || crypto.randomUUID(), title: document.title || "Untitled document", text: String(document.text || ""),
    createdAt: document.createdAt || document.date || Date.now(), updatedAt: document.updatedAt || document.date || Date.now(),
    lastUsedAt: document.lastUsedAt || document.date || Date.now()
  }));
  let recentTexts = JSON.parse(localStorage.getItem("vocalisRecent") || "null") || savedTexts.map((document) => ({ ...document }));
  let currentDocumentId = null;
  let activeLibrary = null;
  const savedSettings = JSON.parse(localStorage.getItem("vocalisSettings") || "{}");

  function toast(message) { els.toast.textContent = message; els.toast.classList.add("show"); setTimeout(() => els.toast.classList.remove("show"), 2400); }
  function apiUrl(path) { return `${API}${path}`; }
  async function api(path, options = {}) {
    const response = await fetch(apiUrl(path), { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }
  function persistSettings() {
    localStorage.setItem("vocalisSettings", JSON.stringify({ rate: els.rate.value, pitch: els.pitch.value, volume: els.volume.value, voice: els.voice.value, theme: document.body.classList.contains("light") ? "light" : "dark" }));
  }
  function persistDocuments() {
    localStorage.setItem("vocalisSavedDocuments", JSON.stringify(savedTexts));
    localStorage.setItem("vocalisRecent", JSON.stringify(recentTexts));
    $("savedCount").textContent = savedTexts.length;
    $("recentCount").textContent = recentTexts.length;
  }
  function titleForText(text) {
    return text.trim().split(/\r?\n/)[0].trim().slice(0, 50) || "Untitled document";
  }
  function setDocumentTitle(title) {
    els.title.textContent = title || "Untitled document";
  }
  function closeLibrary() {
    activeLibrary = null;
    els.library.hidden = true;
    document.querySelectorAll("[data-library]").forEach((item) => item.classList.remove("active"));
  }
  function touchRecent(text = els.text.value) {
    if (!text.trim()) return;
    const now = Date.now();
    const title = els.title.textContent === "Untitled document" ? titleForText(text) : els.title.textContent;
    if (!currentDocumentId) currentDocumentId = crypto.randomUUID();
    const existing = recentTexts.find((document) => document.id === currentDocumentId);
    const record = existing || { id: currentDocumentId, createdAt: now, saved: false };
    Object.assign(record, { title, text, updatedAt: now, lastUsedAt: now });
    recentTexts = [record, ...recentTexts.filter((document) => document.id !== currentDocumentId)].slice(0, 20);
    persistDocuments();
  }
  function renderLibrary(kind) {
    activeLibrary = kind;
    const documents = kind === "saved" ? savedTexts : recentTexts.slice().sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    els.library.hidden = false;
    const empty = kind === "saved" ? "No saved texts yet. Save a document to keep it here." : "No recent texts yet.";
    els.library.innerHTML = `<h2>${kind === "saved" ? "Saved texts" : "Recent texts"}</h2><p>${documents.length ? "Select a document to open it in the editor." : empty}</p>${documents.length ? `<div class="library-list">${documents.map((document) => `<button class="library-item" type="button" data-document-id="${document.id}"><span><strong>${document.title}</strong><small>${document.text.length.toLocaleString()} characters</small></span><small>${new Date(document.lastUsedAt || document.updatedAt).toLocaleDateString()}</small></button>`).join("")}</div>` : ""}`;
    document.querySelectorAll("[data-library]").forEach((item) => item.classList.toggle("active", item.dataset.library === kind));
  }
  function openDocument(document) {
    currentDocumentId = document.id;
    els.text.value = document.text;
    setDocumentTitle(document.title);
    touchRecent(document.text);
    generated = null;
    els.audioPanel.hidden = true;
    closeLibrary();
    updateCounts();
    updateProgress(0);
    setStatus("Ready to listen");
    els.text.focus();
  }
  function updateRangeLabels() { els.rateValue.textContent = `${Number(els.rate.value).toFixed(1)}x`; els.pitchValue.textContent = Number(els.pitch.value).toFixed(1); els.volumeValue.textContent = `${Math.round(els.volume.value * 100)}%`; persistSettings(); }
  function updateCounts() {
    const text = els.text.value, words = text.trim() ? text.trim().split(/\s+/).length : 0;
    els.words.textContent = `${words.toLocaleString()} ${words === 1 ? "word" : "words"}`;
    els.chars.textContent = `${text.length.toLocaleString()} ${text.length === 1 ? "character" : "characters"}`;
  }
  function setStatus(label, kind = "ready") { els.status.textContent = label; els.dot.className = `status-dot ${kind}`; els.playbackTitle.textContent = label; }
  function updateProgress(value) { const percent = Math.max(0, Math.min(100, Math.round(value))); els.percent.textContent = `${percent}%`; els.fill.style.width = `${percent}%`; document.querySelector('[role="progressbar"]').setAttribute("aria-valuenow", percent); }
  function setGenerationProgress(chunk, total, detail = "") { els.chunk.textContent = total ? `Chunk ${chunk} of ${total}` : detail; updateProgress(total ? (chunk / total) * 100 : 0); }
  function splitForUi(text) { return text.split(/(?<=[.!?])\s+/).filter(Boolean); }
  function selectedVoice() { return els.voice.value || ""; }
  async function loadVoices() {
    try {
      const { voices } = await api("/api/voices");
      els.voice.innerHTML = voices.map((voice) => `<option value="${voice.name}|||${voice.lang}">${voice.name} — ${voice.lang}${voice.engine ? ` (${voice.engine})` : ""}</option>`).join("");
      if (savedSettings.voice && [...els.voice.options].some((option) => option.value === savedSettings.voice)) els.voice.value = savedSettings.voice;
      const langs = [...new Set(voices.map((voice) => voice.lang))].sort();
      els.language.innerHTML = `<option value="all">All languages</option>${langs.map((lang) => `<option value="${lang}">${lang}</option>`).join("")}`;
    } catch (error) { els.note.textContent = `Start the local backend to load voices and generate audio: ${error.message}`; els.voice.innerHTML = '<option value="">No voices available</option>'; }
  }
  async function loadDiagnostics() {
    try {
      const diagnostic = await api("/api/diagnostics");
      const voiceSummary = diagnostic.voiceCount ? `${diagnostic.voiceCount} available` : "None detected";
      els.diagnostics.innerHTML = [
        ["Platform", `${diagnostic.platform} · ${diagnostic.architecture}`],
        ["TTS engine", diagnostic.engine],
        ["Voices", voiceSummary],
        ["FFmpeg", diagnostic.ffmpeg ? "Available" : "Unavailable"],
        ["Backend", diagnostic.backend]
      ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
    } catch (error) {
      els.diagnostics.innerHTML = `<span>Diagnostics unavailable: ${error.message}</span>`;
    }
  }
  function options() { return { voice: selectedVoice(), language: els.language.value === "all" ? "en-us" : els.language.value, rate: Number(els.rate.value), pitch: Number(els.pitch.value), volume: Number(els.volume.value) }; }
  function downloadFile(url, filename) {
    const link = document.createElement("a");
    link.href = apiUrl(url);
    link.download = filename;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
  function setAudio(result) {
    generated = result; const mp3Url = apiUrl(result.mp3);
    els.audioPanel.hidden = false; els.audio.src = mp3Url; els.audio.load(); els.audioStatus.textContent = "Audio ready"; els.audioFormat.textContent = `${result.chunks} chunk${result.chunks === 1 ? "" : "s"} · WAV + MP3`;
    els.chunk.textContent = `${result.chunks} chunk${result.chunks === 1 ? "" : "s"} generated`;
    els.downloadWav.disabled = false; els.downloadMp3.disabled = false; els.downloadWav.onclick = () => downloadFile(result.wav, `${result.filename}.wav`); els.downloadMp3.onclick = () => downloadFile(result.mp3, `${result.filename}.mp3`);
    els.playbackDetail.textContent = result.filename; setStatus("Finished", "finished"); updateProgress(100);
  }
  async function generateAudio() {
    const text = els.text.value.trim(); if (!text) return toast("Add some text before generating audio.");
    els.generate.disabled = true; els.audioPanel.hidden = false; els.audioStatus.textContent = "Generating WAV and MP3 locally…"; chunks = splitForUi(text); setStatus("Generating audio", "speaking"); setGenerationProgress(0, chunks.length);
    try {
      const result = await api("/api/tts/generate", { method: "POST", body: JSON.stringify({ text, filename: els.title.textContent, options: options() }) });
      setAudio(result); toast("Audio generated locally.");
    } catch (error) { setStatus("Generation failed", "paused"); els.audioStatus.textContent = error.message; els.note.textContent = error.message; toast(error.message); }
    finally { els.generate.disabled = false; }
  }
  function audioState() { return els.audio.paused ? "paused" : "speaking"; }
  function playAudio() { if (!generated) return generateAudio(); els.audio.play().catch(() => toast("Audio playback was blocked. Press play again.")); }
  function stopAudio() { els.audio.pause(); els.audio.currentTime = 0; setStatus(generated ? "Finished" : "Ready to listen", generated ? "finished" : "ready"); }
  function restartAudio() { if (!generated) return generateAudio(); els.audio.currentTime = 0; playAudio(); }
  function updateAudioProgress() { if (!els.audio.duration) return; updateProgress((els.audio.currentTime / els.audio.duration) * 100); els.audioDuration.textContent = `${Math.floor(els.audio.currentTime / 60)}:${String(Math.floor(els.audio.currentTime % 60)).padStart(2, "0")} / ${Math.floor(els.audio.duration / 60)}:${String(Math.floor(els.audio.duration % 60)).padStart(2, "0")}`; }
  function renderBatch() {
    els.batchList.innerHTML = batchDocuments.length ? batchDocuments.map((document, index) => {
      const result = batchResults[index], status = result?.status || "queued";
      return `<div class="batch-item"><div><strong>${document.name}</strong><small class="${status === "failed" ? "failed" : ""}">${status}${result?.error ? ` — ${result.error}` : ""}</small></div><div class="batch-downloads">${result?.mp3 ? `<button data-download="${result.mp3}">MP3</button><button data-download="${result.wav}">WAV</button>` : ""}${status === "failed" ? `<button data-retry="${index}">Retry</button>` : ""}</div></div>`;
    }).join("") : '<p class="empty-batch">Add chapters or documents to generate them sequentially.</p>';
    els.generateAll.disabled = !batchDocuments.length || batchDocuments.every((_, index) => batchResults[index]?.status === "completed");
    els.downloadAll.disabled = !batchResults.some((result) => result?.status === "completed");
  }
  async function generateAll() {
    els.generateAll.disabled = true; els.batchProgress.hidden = false; batchResults = batchDocuments.map(() => ({ status: "queued" })); renderBatch();
    for (let index = 0; index < batchDocuments.length; index += 1) {
      const document = batchDocuments[index]; els.batchStatus.textContent = `Processing ${index + 1} / ${batchDocuments.length} · ${document.name}`; els.batchPercentage.textContent = `${Math.round(index / batchDocuments.length * 100)}%`; els.batchFill.style.width = `${index / batchDocuments.length * 100}%`;
      try { batchResults[index] = { ...(await api("/api/tts/generate", { method: "POST", body: JSON.stringify({ text: document.text, filename: document.name.replace(/\.txt$/i, ""), options: options() }) })), status: "completed" }; }
      catch (error) { batchResults[index] = { status: "failed", filename: document.name, error: error.message }; }
      renderBatch();
    }
    els.batchStatus.textContent = `Processed ${batchDocuments.length} document${batchDocuments.length === 1 ? "" : "s"}`; els.batchPercentage.textContent = "100%"; els.batchFill.style.width = "100%"; renderBatch();
  }
  async function downloadAll() {
    const files = batchResults.filter((result) => result?.status === "completed").flatMap((result) => [{ path: result.mp3, name: `${result.filename}.mp3` }, { path: result.wav, name: `${result.filename}.wav` }]);
    const response = await fetch(apiUrl("/api/batch/zip"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files }) });
    if (!response.ok) return toast("Unable to create ZIP."); const blob = await response.blob(); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "Vocalis_Output.zip"; link.click(); URL.revokeObjectURL(link.href);
  }
  function newDocument() { currentDocumentId = null; closeLibrary(); els.text.value = ""; setDocumentTitle("Untitled document"); generated = null; els.audioPanel.hidden = true; updateCounts(); updateProgress(0); setStatus("Ready to listen"); els.text.focus(); }

  ["rate", "pitch", "volume"].forEach((key) => { if (savedSettings[key] !== undefined) els[key].value = savedSettings[key]; }); if (savedSettings.theme === "light") document.body.classList.add("light"); updateRangeLabels(); updateCounts(); loadVoices(); loadDiagnostics();
  els.text.addEventListener("input", () => { updateCounts(); if (els.text.value.trim()) { if (els.title.textContent === "Untitled document") setDocumentTitle(titleForText(els.text.value)); touchRecent(); } });
  [els.rate, els.pitch, els.volume].forEach((input) => input.addEventListener("input", updateRangeLabels)); els.voice.addEventListener("change", persistSettings);
  els.generate.addEventListener("click", generateAudio); els.play.addEventListener("click", () => { if (els.audio.paused) playAudio(); else { els.audio.pause(); setStatus("Paused", "paused"); } }); els.stop.addEventListener("click", stopAudio); els.restart.addEventListener("click", restartAudio);
  els.previous.addEventListener("click", () => { if (generated) { els.audio.currentTime = Math.max(0, els.audio.currentTime - 15); } }); els.next.addEventListener("click", () => { if (generated) { els.audio.currentTime = Math.min(els.audio.duration || 0, els.audio.currentTime + 15); } });
  els.audio.addEventListener("timeupdate", updateAudioProgress); els.audio.addEventListener("play", () => setStatus("Speaking", "speaking")); els.audio.addEventListener("pause", () => { if (!els.audio.ended) setStatus("Paused", "paused"); }); els.audio.addEventListener("ended", () => { setStatus("Finished", "finished"); updateProgress(100); });
  $("clearText").addEventListener("click", newDocument); $("newDocument").addEventListener("click", newDocument);
  $("saveText").addEventListener("click", () => {
    const text = els.text.value.trim();
    if (!text) return toast("There is no text to save.");
    touchRecent(text);
    const title = els.title.textContent === "Untitled document" ? titleForText(text) : els.title.textContent;
    const now = Date.now();
    const existing = savedTexts.find((document) => document.id === currentDocumentId);
    if (existing) Object.assign(existing, { title, text, updatedAt: now, lastUsedAt: now });
    else savedTexts.unshift({ id: currentDocumentId, title, text, createdAt: now, updatedAt: now, lastUsedAt: now, saved: true });
    const recent = recentTexts.find((document) => document.id === currentDocumentId);
    if (recent) recent.saved = true;
    savedTexts = savedTexts.slice(0, 20);
    setDocumentTitle(title);
    persistDocuments();
    if (activeLibrary) renderLibrary(activeLibrary);
    toast("Text saved locally.");
  });
  $("copyText").addEventListener("click", async () => { try { await navigator.clipboard.writeText(els.text.value); toast("Text copied."); } catch { toast("Copy permission was denied."); } }); $("pasteText").addEventListener("click", async () => { try { els.text.value = await navigator.clipboard.readText(); els.text.dispatchEvent(new Event("input")); } catch { toast("Paste permission was denied."); } });
  $("fileInput").addEventListener("change", (event) => { const file = event.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { els.text.value = reader.result; els.text.dispatchEvent(new Event("input")); }; reader.readAsText(file); event.target.value = ""; });
  els.batchInput.addEventListener("change", (event) => { batchDocuments = [...batchDocuments, ...[...event.target.files].map((file) => ({ name: file.name, text: null }))]; let pending = batchDocuments.filter((document) => !document.text); Promise.all(pending.map((document) => new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => { document.text = reader.result; resolve(); }; reader.readAsText([...event.target.files].find((file) => file.name === document.name)); }))).then(renderBatch); event.target.value = ""; });
  els.batchList.addEventListener("click", (event) => { const download = event.target.dataset.download; if (download) downloadFile(download, download.endsWith(".wav") ? "Vocalis_Output.wav" : "Vocalis_Output.mp3"); const retry = event.target.dataset.retry; if (retry) { batchResults[retry] = { status: "queued" }; generateAll(); } }); els.generateAll.addEventListener("click", generateAll); els.downloadAll.addEventListener("click", downloadAll);
  document.querySelectorAll("[data-library]").forEach((item) => item.addEventListener("click", () => renderLibrary(item.dataset.library)));
  els.library.addEventListener("click", (event) => { const id = event.target.closest("[data-document-id]")?.dataset.documentId; if (id) { const document = [...recentTexts, ...savedTexts].find((item) => item.id === id); if (document) openDocument(document); } });
  $("themeToggle").addEventListener("click", () => { document.body.classList.toggle("light"); persistSettings(); }); $("readingMode").addEventListener("click", () => { document.body.classList.add("reading-mode"); closeLibrary(); els.text.focus(); }); els.exitReading.addEventListener("click", () => { document.body.classList.remove("reading-mode"); els.text.focus(); });
  persistDocuments();
})();
