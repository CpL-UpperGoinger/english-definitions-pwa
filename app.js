"use strict";

const MAX_QUERY_LENGTH = 40;
const MAX_RESULTS = 50;
const ONLINE_API = "https://freedictionaryapi.com/api/v1/entries/en/";
const CACHE_DB = "yingshi-dictionary-cache";
const CACHE_STORE = "entries";
const state = {
  indexCache: new Map(),
  detailCache: new Map(),
  query: "",
  results: [],
  searchToken: 0,
  entryToken: 0,
  dbPromise: null,
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
  emptyTitle: document.getElementById("empty-title"),
  emptyMessage: document.getElementById("empty-message"),
  emptyClear: document.getElementById("empty-clear"),
  online: document.getElementById("online-button"),
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

function detailShard(word) {
  const letters = word.replace(/[^a-z]/g, "");
  return (letters.slice(0, 2) || word[0]).padEnd(2, "_");
}

async function loadJson(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  const data = await response.json();
  if (!data) throw new Error(`${label} is invalid`);
  return data;
}

async function loadIndex(letter) {
  if (!/^[a-z]$/.test(letter)) return [];
  if (!state.indexCache.has(letter)) {
    const promise = loadJson(`data/index/${letter}.json`, `Index ${letter}`).catch((error) => {
      state.indexCache.delete(letter);
      throw error;
    });
    state.indexCache.set(letter, promise);
  }
  return state.indexCache.get(letter);
}

async function loadDetails(word) {
  const key = detailShard(word);
  if (!state.detailCache.has(key)) {
    const promise = loadJson(`data/words/${key}.json`, `Dictionary shard ${key}`).then((entries) => {
      if (!Array.isArray(entries)) throw new Error(`Dictionary shard ${key} is invalid`);
      return entries;
    }).catch((error) => {
      state.detailCache.delete(key);
      throw error;
    });
    state.detailCache.set(key, promise);
  }
  const entries = await state.detailCache.get(key);
  return entries.find((entry) => entry.w === word) || null;
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

function openCacheDb() {
  if (!("indexedDB" in window)) return Promise.resolve(null);
  if (state.dbPromise) return state.dbPromise;
  state.dbPromise = new Promise((resolve) => {
    const request = indexedDB.open(CACHE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(CACHE_STORE, { keyPath: "w" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return state.dbPromise;
}

async function getCachedEntry(word) {
  const db = await openCacheDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const request = db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).get(word);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
}

async function saveCachedEntry(entry) {
  const db = await openCacheDb();
  if (!db) return false;
  return new Promise((resolve) => {
    const transaction = db.transaction(CACHE_STORE, "readwrite");
    transaction.objectStore(CACHE_STORE).put({ ...entry, cachedAt: Date.now() });
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => resolve(false);
    transaction.onabort = () => resolve(false);
  });
}

function normalizeOnlineEntry(payload, requestedWord) {
  if (!payload || !Array.isArray(payload.entries)) return null;
  const meanings = new Map();
  let phonetic = "";
  for (const item of payload.entries) {
    if (item.language?.code && item.language.code !== "en") continue;
    const pos = String(item.partOfSpeech || "entry").trim();
    if (!meanings.has(pos)) meanings.set(pos, []);
    const definitions = meanings.get(pos);
    for (const sense of item.senses || []) {
      const text = String(sense.definition || "").trim();
      if (!text || definitions.some((definition) => definition.t === text) || definitions.length >= 12) continue;
      const definition = { t: text };
      const example = (sense.examples || []).find((value) => typeof value === "string" && value.trim());
      if (example) definition.e = example.trim();
      definitions.push(definition);
    }
    if (!phonetic) {
      const pronunciation = (item.pronunciations || []).find((value) => value.text && value.text.trim());
      if (pronunciation) phonetic = pronunciation.text.trim();
    }
  }
  const compact = Array.from(meanings, ([pos, d]) => ({ pos, d })).filter((meaning) => meaning.d.length);
  if (!compact.length) return null;
  return {
    w: String(payload.word || requestedWord).toLowerCase(),
    p: phonetic,
    m: compact,
    u: payload.source?.url || `https://en.wiktionary.org/wiki/${encodeURIComponent(requestedWord.replace(/ /g, "_"))}`,
    online: true,
  };
}

async function fetchOnlineEntry(word) {
  if (!navigator.onLine) throw new Error("offline");
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(ONLINE_API + encodeURIComponent(word), {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 404) throw new Error("not-found");
    if (response.status === 429) throw new Error("rate-limit");
    if (!response.ok) throw new Error("service");
    return normalizeOnlineEntry(await response.json(), word);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("timeout");
    if (["offline", "not-found", "rate-limit", "service"].includes(error.message)) throw error;
    throw new Error("network");
  } finally {
    window.clearTimeout(timer);
  }
}

function onlineErrorMessage(code, word) {
  const messages = {
    offline: "当前处于离线状态。联网后可在线补查，已缓存的词条仍可离线查看。",
    "not-found": `线上词库也未找到「${word}」，请检查拼写。`,
    "rate-limit": "在线接口请求过于频繁，请稍后再试。本地词库仍可正常使用。",
    timeout: "在线查询超时，请检查网络后重试。",
    network: "网络连接失败，请检查网络后重试。",
    service: "在线词典服务暂时不可用，请稍后重试。",
  };
  return messages[code] || "在线查询失败，请稍后重试。";
}

function setStatus(message = "") {
  elements.status.textContent = message;
}

function updateSearchHash(query) {
  const next = query ? `#/search?q=${encodeURIComponent(query)}` : `${window.location.pathname}${window.location.search}`;
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
  if (entry.online) {
    const cached = document.createElement("span");
    cached.className = "cached-label";
    cached.textContent = "已缓存";
    wordLine.appendChild(cached);
  }
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
  elements.emptyTitle.textContent = "本地词库未收录";
  elements.emptyMessage.textContent = `未在本地找到「${query}」。你可以联网补查，成功后该词会保存在此浏览器中。`;
  elements.online.hidden = false;
  elements.online.disabled = false;
  elements.online.dataset.word = query;
  elements.online.textContent = "在线补查";
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
  setStatus("正在加载本地词库…");
  const token = ++state.searchToken;
  try {
    const [entries, cached] = await Promise.all([loadIndex(query[0]), getCachedEntry(query)]);
    if (token !== state.searchToken) return;
    state.results = searchEntries(entries, query);
    if (cached && !state.results.some((entry) => entry.w === cached.w)) state.results.unshift(cached);
    renderResults(state.results, query);
    setStatus();
    document.title = `${query} · 英释随心查`;
  } catch (error) {
    if (token !== state.searchToken) return;
    setStatus("词库加载失败，请检查网络后再次查询。");
    elements.empty.hidden = false;
    elements.emptyTitle.textContent = "词库暂时无法加载";
    elements.emptyMessage.textContent = "请检查网络后重试；已缓存的页面和词条仍可离线使用。";
    elements.online.hidden = true;
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
  eyebrow.textContent = entry.online ? "ENGLISH ENTRY · SAVED OFFLINE" : "ENGLISH ENTRY";
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
  attribution.textContent = entry.online
    ? "释义来自 English Wiktionary，由 FreeDictionaryAPI.com 在线提供并已缓存到本浏览器；内容采用 CC BY-SA 4.0 许可。"
    : "释义来自 English Wiktionary，经 kaikki.org / Wiktextract 结构化处理；内容采用 CC BY-SA 4.0 许可。";
  const link = document.createElement("a");
  link.href = safeExternalUrl(entry.u, entry.w);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "在 Wiktionary 查看原词条";
  source.append(attribution, link);
  article.appendChild(source);
  return article;
}

function renderEntryError(word, message, offerOnline = false) {
  elements.entry.replaceChildren();
  const container = document.createElement("div");
  container.className = "entry-error";
  const title = document.createElement("h1");
  title.textContent = offerOnline ? "本地词库未收录" : "暂时无法显示词条";
  const text = document.createElement("p");
  text.textContent = message || `本地词库中未找到「${word}」。你可以联网补查并保存到浏览器。`;
  const actions = document.createElement("div");
  actions.className = "error-actions";
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "返回搜索";
  back.addEventListener("click", goBackToSearch);
  actions.appendChild(back);
  if (offerOnline) {
    const online = document.createElement("button");
    online.type = "button";
    online.className = "primary-action";
    online.textContent = "在线补查";
    online.addEventListener("click", () => lookupOnline(word, online));
    actions.appendChild(online);
  }
  container.append(title, text, actions);
  elements.entry.appendChild(container);
}

async function lookupOnline(word, button) {
  const token = ++state.entryToken;
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = "正在在线查询…";
  setStatus("正在请求开放词典接口…");
  try {
    const entry = await fetchOnlineEntry(word);
    if (!entry) throw new Error("not-found");
    const saved = await saveCachedEntry(entry);
    if (token !== state.entryToken) return;
    setStatus();
    if (!elements.entry.hidden) {
      elements.entry.replaceChildren(createEntryArticle(entry));
      window.scrollTo(0, 0);
    } else {
      goToWord(word);
    }
    if (!saved) console.warn("Online entry could not be persisted in IndexedDB");
  } catch (error) {
    if (token !== state.entryToken) return;
    const message = onlineErrorMessage(error.message, word);
    setStatus("");
    if (!elements.entry.hidden) {
      renderEntryError(word, message, !["not-found", "offline"].includes(error.message));
    } else {
      elements.emptyTitle.textContent = "在线查询未完成";
      elements.emptyMessage.textContent = message;
      elements.online.hidden = error.message === "not-found";
    }
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = oldText;
    }
  }
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
  setStatus("正在读取词条…");
  document.title = `${word} · 英释随心查`;
  try {
    const cached = await getCachedEntry(word);
    if (token !== state.entryToken) return;
    if (cached) {
      elements.entry.replaceChildren(createEntryArticle(cached));
      setStatus();
      window.scrollTo(0, 0);
      return;
    }
    const entries = await loadIndex(word[0]);
    if (token !== state.entryToken) return;
    if (!entries.some((entry) => entry.w === word)) {
      setStatus();
      renderEntryError(word, "", true);
      return;
    }
    const entry = await loadDetails(word);
    if (token !== state.entryToken) return;
    setStatus();
    if (!entry) {
      renderEntryError(word, "本地词条数据不完整，请稍后重试。");
      return;
    }
    elements.entry.replaceChildren(createEntryArticle(entry));
    window.scrollTo(0, 0);
  } catch (error) {
    if (token !== state.entryToken) return;
    setStatus();
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
  searchTimer = window.setTimeout(() => performSearch(sanitized), 180);
});

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  window.clearTimeout(searchTimer);
  const query = normalizeQuery(elements.input.value);
  const exact = state.results.find((entry) => entry.w === query);
  if (query && state.query === query) goToWord(exact ? exact.w : query);
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
elements.online.addEventListener("click", () => lookupOnline(elements.online.dataset.word, elements.online));
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
