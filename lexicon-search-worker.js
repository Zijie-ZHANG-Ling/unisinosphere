
/* UniSinosphere TSV fuzzy search. Runs in a Web Worker so the UI stays responsive.
   Each TSV must have: hangul, hanja, rrspeech, rrraw, rrrawsep (tab-separated). */
"use strict";

const FILES = ["hangul_hanja_part1.tsv", "hangul_hanja_part2.tsv"];
const COLUMNS = ["hangul", "hanja", "rrspeech", "rrraw", "rrrawsep"];
const PAGE_SIZE = 60;
const lexicon = [];
let loadingPromise = null;
const recentRequest = new Map();
const resultSets = new Map();

// NFC -> lowercase -> remove whitespace / hyphen-like separators / apostrophes.
// Apply exactly the same processing to the query and EVERY TSV column.
function normalize(value) {
  return value.normalize("NFC").toLowerCase()
    .replace(/[\s\u200B-\u200D\uFEFF\-\u2010-\u2015\u2212\u00B7\u30FB'\u2019\uFF07]/gu, "");
}

function sendProgress(message) {
  self.postMessage({ type: "progress", message });
}

// Stream the TSV, avoiding an additional 20-25 MB whole-file text allocation.
async function readTsv(filename) {
  const response = await fetch(filename);
  if (!response.ok) throw new Error(`${filename} 讀取失敗（HTTP ${response.status}）。請確認它位於 GitHub 倉庫根目錄。`);

  let lineNumber = 0;
  const addLine = line => {
    ++lineNumber;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (lineNumber === 1) {
      if (line.replace(/^\uFEFF/, "") !== COLUMNS.join("\t")) {
        throw new Error(`${filename} 的五列表頭不正確。需要：${COLUMNS.join(" / ")}`);
      }
      return;
    }
    if (!line) return;
    const raw = line.split("\t");
    if (raw.length !== 5) throw new Error(`${filename} 第 ${lineNumber} 行不是五欄。`);
    const normalized = raw.map(normalize);
    lexicon.push({ raw, normalized });
  };

  if (response.body && response.body.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let leftover = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = leftover + decoder.decode(value, { stream: true });
      let start = 0;
      let end;
      while ((end = text.indexOf("\n", start)) !== -1) {
        addLine(text.slice(start, end));
        start = end + 1;
      }
      leftover = text.slice(start);
    }
    leftover += decoder.decode();
    if (leftover) addLine(leftover);
  } else {
    // Fallback for environments without streaming fetch.
    for (const line of (await response.text()).split("\n")) addLine(line);
  }
  return lineNumber - 1;
}

function ensureLoaded() {
  if (!loadingPromise) {
    loadingPromise = (async () => {
      lexicon.length = 0;
      for (let i = 0; i < FILES.length; i++) {
        sendProgress(`正在載入詞庫 ${i + 1}/${FILES.length}：${FILES[i]} ……`);
        await readTsv(FILES[i]);
      }
      sendProgress(`詞庫載入完成：共 ${lexicon.length.toLocaleString()} 筆記錄。正在搜尋……`);
    })().catch(error => {
      loadingPromise = null;
      lexicon.length = 0;
      throw error;
    });
  }
  return loadingPromise;
}

// Unicode code-point length (supplementary-plane Hanja count as one character).
function codePointLength(text) {
  return /[\uD800-\uDBFF]/u.test(text) ? Array.from(text).length : text.length;
}

// Levenshtein edit distance. With a cutoff, and bounded DP for long words.
function editDistanceWithin(a, b, limit) {
  let n = a.length, m = b.length;
  if (Math.abs(n - m) > limit) return limit + 1;
  if (!n) return m;
  if (!m) return n;
  if (n > m) { [a, b] = [b, a]; [n, m] = [m, n]; }

  let previous = new Int32Array(n + 1);
  let current = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++) previous[i] = i;

  for (let j = 1; j <= m; j++) {
    current.fill(limit + 1);
    current[0] = j;
    const start = Math.max(1, j - limit);
    const stop = Math.min(n, j + limit);
    let min = limit + 1;
    for (let i = start; i <= stop; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(previous[i] + 1, current[i - 1] + 1, previous[i - 1] + cost);
      current[i] = v;
      if (v < min) min = v;
    }
    if (min > limit) return limit + 1;
    [previous, current] = [current, previous];
  }
  return previous[n];
}

// Similarity = 1 - LevenshteinDistance / max(codepoint lengths).
// Strictly > 60% iff 5 * distance < 2 * maxLength.
function similarityOver60(queryCharacters, field) {
  if (!field) return 0;
  const n = queryCharacters.length;
  const m = codePointLength(field);
  const maxLen = Math.max(n, m);
  const maxAllowedEdits = Math.floor((2 * maxLen - 1) / 5);
  if (Math.abs(n - m) > maxAllowedEdits) return 0;
  const distance = editDistanceWithin(queryCharacters, Array.from(field), maxAllowedEdits);
  return 5 * distance < 2 * maxLen ? 1 - distance / maxLen : 0;
}

function serialize(matches, start) {
  return matches.slice(start, start + PAGE_SIZE).map(match => {
    const raw = lexicon[match.index].raw;
    return { hangul: raw[0], hanja: raw[1], rrspeech: raw[2], rrrawsep: raw[4] };
  });
}

async function runSearch(context, requestId, value) {
  const query = normalize(value);
  if (!query) {
    self.postMessage({ type: "results", context, requestId, total: 0, items: [], loaded: 0 });
    return;
  }
  try {
    await ensureLoaded();
    if (recentRequest.get(context) !== requestId) return;
    const queryCharacters = Array.from(query);
    const matches = [];
    const count = lexicon.length;

    for (let index = 0; index < count; index++) {
      const entry = lexicon[index];
      let best = 0;
      // Check all five columns independently. A row qualifies if ANY column > 60%.
      for (const field of entry.normalized) {
        const score = similarityOver60(queryCharacters, field);
        if (score > best) best = score;
        if (best === 1) break; // Exact match: no other column can improve it.
      }
      if (best > 0.6) matches.push({ index, best });

      // Allow queued messages (e.g. a new search) to interrupt a long scan.
      if (index > 0 && index % 15000 === 0) {
        if (recentRequest.get(context) !== requestId) return;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    if (recentRequest.get(context) !== requestId) return;
    // Highest similarity first, original TSV order for equal scores.
    matches.sort((a, b) => b.best - a.best || a.index - b.index);
    resultSets.set(context, { requestId, matches });
    const items = serialize(matches, 0);
    self.postMessage({ type: "results", context, requestId, total: matches.length,
      items, loaded: items.length, entries: count });
  } catch (error) {
    if (recentRequest.get(context) === requestId) {
      self.postMessage({ type: "error", context, requestId, message: error.message });
    }
  }
}

self.addEventListener("message", ({ data }) => {
  if (data.type === "search") {
    recentRequest.set(data.context, data.requestId);
    resultSets.delete(data.context);
    void runSearch(data.context, data.requestId, data.value);
  } else if (data.type === "more") {
    const set = resultSets.get(data.context);
    if (!set || set.requestId !== data.requestId) return;
    const items = serialize(set.matches, data.offset);
    self.postMessage({ type: "more", context: data.context,
      requestId: data.requestId, items, loaded: data.offset + items.length,
      total: set.matches.length });
  } else if (data.type === "cancel") {
    recentRequest.set(data.context, data.requestId);
    resultSets.delete(data.context);
  }
});
