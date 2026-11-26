"use strict";

const MAX_QUERY_LENGTH = 40;
const MAX_RESULTS = 50;
const state = {
  cache: new Map(),
  query: "",
  results: [],
  searchToken: 0,
  entryToken: 0,
};

const elements = {
  body: document.body,
  form: document.getElementById("search-form"),
  input: document.getElementById("search-input"),
  clear: document.getElementById("clear-button"),
  searchPanel: document.getElementById("search-panel"),
  status: document.getElementById("load-status"),
  homeNote: document.getElementById("home-note"),
  results: document.getElementById("results"),
  resultList: document.getElementById("result-list"),
  resultCount: document.getElementById("result-count"),
  empty: document.getElementById("empty-state"),
  emptyMessage: document.getElementById("empty-message"),
  emptyClear: document.getElementById("empty-clear"),
  entry: document.getElementById("entry-view"),
  back: document.getElementById("back-button"),
  dataSummary: document.getElementById("data-summary"),
  licenseButton: document.getElementById("license-button"),
  licenseDialog: document.getElementById("license-dialog"),
};

function sanitizeInput(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z -]/g, "")
    .replace(/ +/g, " ")
    .replace(/-{2,}/g, "-")
    .replace(/^ +/, "")
    .slice(0, MAX_QUERY_LENGTH);
}

function normalizeQuery(value) {
  return sanitizeInput(value).trim();
}

async function loadLetter(letter) {
  if (!/^[a-z]$/.test(letter)) return [];
  if (state.cache.has(letter)) return state.cache.get(letter);

  const promise = fetch(`data/${letter}.json`)
    .then((response) => {
      if (!response.ok) throw new Error(`Dictionary shard ${letter}: HTTP ${response.status}`);
      return response.json();
    })
    .then((entries) => {
      if (!Array.isArray(entries)) throw new Error(`Dictionary shard ${letter} is invalid`);
      return entries;
    })
    .catch((error) => {
      state.cache.delete(letter);
      throw error;
    });

  state.cache.set(letter, promise);
  return promise;
}

function searchEntries(entries, query) {
  const matches = [];
  for (const entry of entries) {
    const word = entry.w;
    let rank = -1;
    if (word === query) rank = 0;
    else if (word.startsWith(query)) rank = 1;
    else if (word.includes(query)) rank = 2;
    if (rank >= 0) matches.push({ entry, rank });
  }
  matches.sort((a, b) => a.rank - b.rank || a.entry.w.localeCompare(b.entry.w));
  return matches.slice(0, MAX_RESULTS).map((match) => match.entry);
}

function firstDefinition(entry) {
  return entry.m?.[0]?.d?.[0]?.t || "暂无释义摘要";
}

function partOfSpeechSummary(entry) {
  return (entry.m || []).slice(0, 2).map((meaning) => meaning.pos).join(" · ");
}

function setStatus(message = "") {
  elements.status.textContent = message;
}

function updateSearchHash(query) {
  const next = query
    ? `#/search?q=${encodeURIComponent(query)}`
    : `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(null, "", next);
}

function showSearchLayout() {
  state.entryToken += 1;
  elements.body.classList.add("has-query");
  elements.body.classList.remove("is-entry");
  elements.searchPanel.hidden = false;
  elements.entry.hidden = true;
  elements.back.hidden = true;
  elements.results.hidden = false;
}

function showHome() {
  state.searchToken += 1;
  state.entryToken += 1;
  state.query = "";
  state.results = [];
  elements.body.classList.remove("has-query", "is-entry");
  elements.input.value = "";
  elements.clear.hidden = true;
  elements.searchPanel.hidden = false;
  elements.homeNote.hidden = false;
  elements.results.hidden = true;
  elements.entry.hidden = true;
  elements.back.hidden = true;
  setStatus();
  document.title = "英释随心查 · English definitions";
}

function createResultButton(entry) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "result-item";
  button.setAttribute("aria-label", `查看 ${entry.w} 的英文释义`);
  button.addEventListener("click", () => goToWord(entry.w));

  const content = document.createElement("div");
  const wordLine = document.createElement("div");
  wordLine.className = "result-word-line";
  const word = document.createElement("span");
  word.className = "result-word";
  word.textContent = entry.w;
  wordLine.appendChild(word);

  if (entry.p) {
    const phonetic = document.createElement("span");
    phonetic.className = "result-phonetic";
    phonetic.textContent = entry.p;
    wordLine.appendChild(phonetic);
  }
  const pos = document.createElement("span");
  pos.className = "result-pos";
  pos.textContent = partOfSpeechSummary(entry);
  wordLine.appendChild(pos);

  const summary = document.createElement("p");
  summary.className = "result-summary";
  summary.textContent = firstDefinition(entry);
  content.append(wordLine, summary);

  const arrow = document.createElement("span");
  arrow.className = "result-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "›";
  button.append(content, arrow);
  return button;
}

function renderResults(entries, query) {
  elements.resultList.replaceChildren();
  elements.empty.hidden = entries.length > 0;
  elements.resultList.hidden = entries.length === 0;
  elements.resultCount.textContent = entries.length ? `${entries.length} 条` : "";
  elements.emptyMessage.textContent = `未找到「${query}」，请检查拼写或尝试更短的词。`;
  const fragment = document.createDocumentFragment();
  entries.forEach((entry) => fragment.appendChild(createResultButton(entry)));
  elements.resultList.appendChild(fragment);
}

async function performSearch(rawQuery, updateHash = true) {
  const query = normalizeQuery(rawQuery);
  state.query = query;
  elements.input.value = sanitizeInput(rawQuery);
  elements.clear.hidden = !elements.input.value;
  if (updateHash) updateSearchHash(query);

  if (!query) {
    showHome();
    return;
  }

  showSearchLayout();
  elements.homeNote.hidden = true;
  elements.results.hidden = false;
  elements.resultList.hidden = true;
  elements.empty.hidden = true;
  elements.resultCount.textContent = "";
  setStatus("正在加载词库…");
  const token = ++state.searchToken;

  try {
    const entries = await loadLetter(query[0]);
    if (token !== state.searchToken) return;
    state.results = searchEntries(entries, query);
    renderResults(state.results, query);
    setStatus();
    document.title = `${query} · 英释随心查`;
  } catch (error) {
    if (token !== state.searchToken) return;
    setStatus("词库加载失败，请检查网络后再次查询。");
    elements.resultCount.textContent = "";
    elements.empty.hidden = false;
    elements.emptyMessage.textContent = "词库暂时无法加载，请稍后重试。";
    console.error(error);
  }
}

function safeExternalUrl(value, fallbackWord) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.href;
  } catch (_) {
    // Fall through to the canonical Wiktionary URL.
  }
  return `https://en.wiktionary.org/wiki/${encodeURIComponent(fallbackWord.replace(/ /g, "_"))}`;
}

function createEntryArticle(entry) {
  const article = document.createElement("article");
  article.className = "entry-card";

  const header = document.createElement("header");
  header.className = "entry-header";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "ENGLISH ENTRY";
  const title = document.createElement("h1");
  title.textContent = entry.w;
  header.append(eyebrow, title);
  if (entry.p) {
    const phonetic = document.createElement("p");
    phonetic.className = "entry-phonetic";
    phonetic.textContent = entry.p;
    header.appendChild(phonetic);
  }
  article.appendChild(header);

  for (const meaning of entry.m || []) {
    const section = document.createElement("section");
    section.className = "sense-group";
    const heading = document.createElement("h2");
    const pos = document.createElement("span");
    pos.textContent = meaning.pos;
    const count = document.createElement("span");
    count.className = "sense-count";
    count.textContent = `${meaning.d.length} ${meaning.d.length === 1 ? "sense" : "senses"}`;
    heading.append(pos, count);
    const list = document.createElement("ol");
    list.className = "sense-list";

    for (const definition of meaning.d) {
      const item = document.createElement("li");
      const text = document.createElement("p");
      text.className = "definition";
      text.textContent = definition.t;
      item.appendChild(text);
      if (definition.e) {
        const example = document.createElement("p");
        example.className = "example";
        example.textContent = definition.e;
        item.appendChild(example);
      }
      list.appendChild(item);
    }
    section.append(heading, list);
    article.appendChild(section);
  }

  const source = document.createElement("footer");
  source.className = "entry-source";
  const attribution = document.createElement("p");
  attribution.textContent = "释义来自 English Wiktionary，由 FreeDictionaryAPI.com 提供结构化数据；内容采用 CC BY-SA 4.0 许可。";
  const link = document.createElement("a");
  link.href = safeExternalUrl(entry.u, entry.w);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "在 Wiktionary 查看原词条";
  source.append(attribution, link);
  article.appendChild(source);
  return article;
}

function renderEntryError(word, message) {
  elements.entry.replaceChildren();
  const container = document.createElement("div");
  container.className = "entry-error";
  const title = document.createElement("h1");
  title.textContent = "暂时无法显示词条";
  const text = document.createElement("p");
  text.textContent = message || `本地词库中未找到「${word}」。`;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "返回搜索";
  button.addEventListener("click", goBackToSearch);
  container.append(title, text, button);
  elements.entry.appendChild(container);
}

async function showEntry(rawWord) {
  let word = "";
  try {
    word = normalizeQuery(decodeURIComponent(rawWord));
  } catch (_) {
    word = "";
  }
  if (!word) {
    goBackToSearch();
    return;
  }
  const token = ++state.entryToken;
  state.searchToken += 1;
  elements.body.classList.add("is-entry");
  elements.body.classList.remove("has-query");
  elements.searchPanel.hidden = true;
  elements.results.hidden = true;
  elements.homeNote.hidden = true;
  elements.entry.hidden = false;
  elements.back.hidden = false;
  elements.entry.replaceChildren();
  setStatus();
  document.title = `${word} · 英释随心查`;

  try {
    const entries = await loadLetter(word[0]);
    if (token !== state.entryToken) return;
    const entry = entries.find((item) => item.w === word);
    if (!entry) {
      renderEntryError(word);
      return;
    }
    elements.entry.replaceChildren(createEntryArticle(entry));
    window.scrollTo(0, 0);
  } catch (error) {
    if (token !== state.entryToken) return;
    renderEntryError(word, "词库加载失败，请检查网络后重试。");
    console.error(error);
  }
}

function goToWord(word) {
  const nextHash = `#/word/${encodeURIComponent(word)}`;
  if (window.location.hash === nextHash) route();
  else window.location.hash = nextHash;
}

function goBackToSearch() {
  if (state.query) {
    window.location.hash = `#/search?q=${encodeURIComponent(state.query)}`;
  } else {
    window.history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
    showHome();
  }
}

function route() {
  const hash = window.location.hash;
  if (hash.startsWith("#/word/")) {
    showEntry(hash.slice(7));
    return;
  }
  if (hash.startsWith("#/search")) {
    const query = new URLSearchParams(hash.split("?")[1] || "").get("q") || "";
    performSearch(query, false);
    return;
  }
  showHome();
}

let searchTimer;
elements.input.addEventListener("input", () => {
  const sanitized = sanitizeInput(elements.input.value);
  if (elements.input.value !== sanitized) elements.input.value = sanitized;
  elements.clear.hidden = !sanitized;
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => performSearch(sanitized), 140);
});

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  window.clearTimeout(searchTimer);
  const query = normalizeQuery(elements.input.value);
  const exact = state.results.find((entry) => entry.w === query);
  if (query && exact && state.query === query) goToWord(exact.w);
  else performSearch(query);
});

elements.clear.addEventListener("click", () => {
  window.clearTimeout(searchTimer);
  updateSearchHash("");
  showHome();
  elements.input.focus();
});
elements.emptyClear.addEventListener("click", () => {
  elements.input.focus();
  elements.input.select();
});
elements.back.addEventListener("click", goBackToSearch);
document.querySelectorAll("[data-word]").forEach((button) => {
  button.addEventListener("click", () => {
    const word = button.dataset.word;
    state.query = word;
    elements.input.value = word;
    goToWord(word);
  });
});
elements.licenseButton.addEventListener("click", () => {
  if (typeof elements.licenseDialog.showModal === "function") elements.licenseDialog.showModal();
  else elements.licenseDialog.setAttribute("open", "");
});
window.addEventListener("hashchange", route);

fetch("data/meta.json")
  .then((response) => response.ok ? response.json() : Promise.reject(new Error("No metadata")))
  .then((meta) => {
    if (Number.isFinite(meta.totalEntries)) {
      elements.dataSummary.textContent = `本地词库 · ${meta.totalEntries.toLocaleString("zh-CN")} 个词条`;
    }
  })
  .catch(() => {});

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((error) => console.warn("Service worker registration failed", error));
  });
}

route();
