// 티스토리 각주 변환기 - 콘텐츠 스크립트

(function () {
  'use strict';

  // ─── Page Bridge 통신 ───

  let bridgeInjected = false;
  let bridgeReady = false;
  let requestId = 0;
  const pendingRequests = new Map();

  function injectBridge() {
    if (bridgeInjected) return;
    if (document.getElementById('tistory-fn-bridge')) {
      bridgeInjected = true;
      return;
    }
    const script = document.createElement('script');
    script.id = 'tistory-fn-bridge';
    script.src = chrome.runtime.getURL('content/page-bridge.js');
    (document.head || document.documentElement).appendChild(script);
    bridgeInjected = true;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'TISTORY_FN_RESPONSE') return;

    const { id } = event.data;
    const resolver = pendingRequests.get(id);
    if (resolver) {
      pendingRequests.delete(id);
      resolver(event.data);
    }
  });

  function sendToBridge(action, value) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error('에디터 접근 시간 초과 — 페이지를 새로고침 후 다시 시도해주세요.'));
      }, 5000);

      pendingRequests.set(id, (resp) => {
        clearTimeout(timeout);
        if (resp.error) {
          reject(new Error(
            resp.error === 'EDITOR_NOT_FOUND'
              ? '에디터를 찾을 수 없습니다. HTML 편집 모드인지 확인해주세요.'
              : resp.error
          ));
        } else {
          resolve(resp);
        }
      });

      window.postMessage({ type: 'TISTORY_FN_REQUEST', id, action, value }, '*');
    });
  }

  // ─── Tistory 에디터 감지 (DOM 조회, content script에서 가능) ───

  function detectTistoryEditor() {
    const cmEl = document.querySelector('.cm-s-tistory-html');
    if (cmEl && cmEl.offsetParent !== null) return 'tistory-cm5';

    const reactCm = document.querySelector('.ReactCodemirror');
    if (reactCm && window.getComputedStyle(reactCm).display !== 'none') {
      if (reactCm.querySelector('.CodeMirror')) return 'tistory-cm5';
    }

    const tinyFrame = document.querySelector('#editor-tistory_ifr');
    if (tinyFrame && tinyFrame.offsetParent !== null) return 'tistory-tinymce';

    return null;
  }

  // ─── 에디터 콘텐츠 읽기/쓰기 ───

  let lastFocusedElement = null;

  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (
      el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' && el.type === 'text') ||
      el.getAttribute('contenteditable') === 'true' ||
      el.closest('.CodeMirror') ||
      el.closest('.cm-editor')
    ) {
      lastFocusedElement = el;
    }
  }, true);

  document.addEventListener('click', (e) => {
    const el = e.target;
    if (
      el.tagName === 'TEXTAREA' ||
      el.getAttribute('contenteditable') === 'true' ||
      el.closest('.CodeMirror') ||
      el.closest('.cm-editor')
    ) {
      lastFocusedElement = el;
    }
  }, true);

  async function getBridgeContent() {
    injectBridge();
    await new Promise((r) => setTimeout(r, 200));
    const resp = await sendToBridge('getValue');
    return { type: resp.editorType || 'bridge', content: resp.data };
  }

  async function setBridgeContent(newContent) {
    injectBridge();
    await new Promise((r) => setTimeout(r, 200));
    await sendToBridge('setValue', newContent);
  }

  function resolveEditorElement() {
    const el = lastFocusedElement;
    if (!el) return null;

    const cmWrapper = (el.closest && el.closest('.CodeMirror')) ||
                      (el.closest && el.closest('.cm-editor'));
    if (cmWrapper) return { type: 'codemirror' };

    if (el.getAttribute && el.getAttribute('contenteditable') === 'true') {
      return { type: 'contenteditable', element: el };
    }
    const editableParent = el.closest && el.closest('[contenteditable="true"]');
    if (editableParent) return { type: 'contenteditable', element: editableParent };

    if (el.tagName === 'TEXTAREA') {
      if (!el.closest('.CodeMirror') && !el.closest('.cm-editor')) {
        return { type: 'textarea', element: el };
      }
    }

    return null;
  }

  async function getContent() {
    const tistoryMode = detectTistoryEditor();
    if (tistoryMode) {
      return await getBridgeContent();
    }

    const editor = resolveEditorElement();
    if (!editor) return null;

    switch (editor.type) {
      case 'codemirror':
        return await getBridgeContent();
      case 'contenteditable':
        return { type: 'contenteditable', content: editor.element.innerHTML };
      case 'textarea':
        return { type: 'textarea', content: editor.element.value };
      default:
        return null;
    }
  }

  async function setContent(newContent) {
    const tistoryMode = detectTistoryEditor();
    if (tistoryMode) {
      await setBridgeContent(newContent);
      return true;
    }

    const editor = resolveEditorElement();
    if (!editor) return false;

    switch (editor.type) {
      case 'codemirror':
        await setBridgeContent(newContent);
        return true;
      case 'contenteditable':
        editor.element.innerHTML = newContent;
        editor.element.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      case 'textarea':
        editor.element.value = newContent;
        editor.element.dispatchEvent(new Event('input', { bubbles: true }));
        editor.element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      default:
        return false;
    }
  }

  // ─── 공통 유틸리티 ───

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // <code>, <pre>, HTML 주석을 플레이스홀더로 치환 (스캔 제외)
  function stripProtectedZones(html) {
    const zones = [];
    let idx = 0;
    const cleaned = html.replace(
      /(<pre[^>]*>[\s\S]*?<\/pre>|<code[^>]*>[\s\S]*?<\/code>|<!--[\s\S]*?-->)/gi,
      (match) => {
        const placeholder = '\x00PZ' + (idx++) + '\x00';
        zones.push({ placeholder, content: match });
        return placeholder;
      }
    );
    return { cleaned, zones };
  }

  function restoreProtectedZones(html, zones) {
    for (const { placeholder, content } of zones) {
      html = html.split(placeholder).join(content);
    }
    return html;
  }

  // ─── 각주 형식 감지 ───

  function detectFootnoteFormat(html) {
    const { cleaned } = stripProtectedZones(html);

    const hasWord = /<a\s+href="#_ftn\d+"/.test(cleaned);
    // [^label] 패턴 (code/pre/comment 제외 후)
    const hasMarkdownRef = /\[\^[^\]\s]+\]/.test(cleaned);
    const hasInline = /\^\[[^\]]+\]/.test(cleaned);
    const hasMarkdown = hasMarkdownRef || hasInline;
    // 이미 변환된 렌더링 HTML (옵시디언/벨로그)
    const hasRendered = /id="fn(?:ref)?[-_]?\d+"/.test(cleaned) || /class="footnote-ref"/.test(cleaned);

    if (hasWord && hasMarkdown) return 'mixed';
    if (hasWord) return 'word';
    if (hasMarkdown) return 'markdown';
    if (hasRendered) return 'rendered';
    return null;
  }

  // ─── Word 각주 탐지 (기존) ───

  const BODY_FOOTNOTE_RE = /<a\s+href="#_ftn(\d+)">((?:<span[^>]*>)*\[\d+\](?:<\/span>)*)<\/a>/g;
  const FOOT_DEFINITION_RE = /<a\s+href="#_ftnref(\d+)">/g;

  function isFootnoteConverted(html, num) {
    return html.includes('id="_ftnref' + num + '"');
  }

  function detectFootnotePairs(html) {
    const bodyMatches = {};
    const footMatches = {};

    let m;
    BODY_FOOTNOTE_RE.lastIndex = 0;
    while ((m = BODY_FOOTNOTE_RE.exec(html)) !== null) {
      const num = m[1];
      if (isFootnoteConverted(html, num)) continue;
      const fullMatch = m[0];
      const start = Math.max(0, m.index - 30);
      const end = Math.min(html.length, m.index + fullMatch.length + 30);
      const context = html.substring(start, end).replace(/<[^>]*>/g, '').trim();
      bodyMatches[num] = { fullMatch, context, index: m.index };
    }

    FOOT_DEFINITION_RE.lastIndex = 0;
    while ((m = FOOT_DEFINITION_RE.exec(html)) !== null) {
      const num = m[1];
      if (isFootnoteConverted(html, num)) continue;
      const fullMatch = m[0];
      const start = m.index;
      const end = Math.min(html.length, m.index + 100);
      const snippet = html.substring(start, end);
      const pEnd = snippet.indexOf('</p>');
      const contextRaw = pEnd > 0 ? snippet.substring(0, pEnd) : snippet;
      const context = contextRaw.replace(/<[^>]*>/g, '').trim();
      footMatches[num] = { fullMatch, context, index: m.index };
    }

    const pairs = [];
    for (const num of Object.keys(bodyMatches).sort((a, b) => +a - +b)) {
      if (footMatches[num]) {
        pairs.push({
          number: +num,
          bodyContext: bodyMatches[num].context,
          footContext: footMatches[num].context,
        });
      }
    }

    const alreadyProcessed = pairs.length === 0 &&
      BODY_FOOTNOTE_RE.test(html) === false &&
      html.includes('id="_ftnref');

    return { pairs, alreadyProcessed };
  }

  // ─── Word 각주 변환 (기존) ───

  function convertSingleFootnote(html, number) {
    const n = number;

    const bodyRe = new RegExp(
      '<a\\s+href="#_ftn' + n + '">((?:<span[^>]*>)*\\[' + n + '\\](?:<\\/span>)*)<\\/a>',
      'g'
    );
    html = html.replace(
      bodyRe,
      '<sup><a id="_ftnref' + n + '" href="#_ftn' + n + '">$1</a></sup>'
    );

    const footRe = new RegExp('<a\\s+href="#_ftnref' + n + '">', 'g');
    html = html.replace(footRe, '<a id="_ftn' + n + '" href="#_ftnref' + n + '">');

    return html;
  }

  function convertAllFootnotes(html) {
    html = html.replace(
      /<a\s+href="#_ftn(\d+)">((?:<span[^>]*>)*\[\d+\](?:<\/span>)*)<\/a>/g,
      '<sup><a id="_ftnref$1" href="#_ftn$1">$2</a></sup>'
    );

    html = html.replace(
      /<a\s+href="#_ftnref(\d+)">/g,
      '<a id="_ftn$1" href="#_ftnref$1">'
    );

    return html;
  }

  // ─── 마크다운 각주 탐지 ───

  function detectMarkdownPairs(html) {
    const { cleaned } = stripProtectedZones(html);

    const bodyRefs = {};   // label -> [{ index, fullMatch }]
    const footDefs = {};   // label -> { content, index }
    const inlines = [];    // [{ content, index, fullMatch }]

    let m;

    // 본문 참조: [^label] (뒤에 : 가 아닌 것만)
    const refRe = /\[\^([^\]\s]+)\](?!\s*:)/g;
    while ((m = refRe.exec(cleaned)) !== null) {
      const label = m[1];
      if (!bodyRefs[label]) bodyRefs[label] = [];
      bodyRefs[label].push({ index: m.index, fullMatch: m[0] });
    }

    // 각주 정의: [^label]: content (같은 <p> 내 또는 줄 끝까지)
    const defRe = /\[\^([^\]\s]+)\]:\s*/g;
    while ((m = defRe.exec(cleaned)) !== null) {
      const label = m[1];
      const afterMatch = m.index + m[0].length;
      const rest = cleaned.substring(afterMatch);
      const endIdx = rest.search(/<\/p>|\n|\[\^[^\]\s]+\]:/);
      const rawContent = endIdx >= 0 ? rest.substring(0, endIdx) : rest;
      const content = rawContent.replace(/<[^>]*>/g, '').trim();
      footDefs[label] = { content, index: m.index };
    }

    // 인라인 각주: ^[content]
    const inlineRe = /\^\[([^\]]+)\]/g;
    while ((m = inlineRe.exec(cleaned)) !== null) {
      inlines.push({ content: m[1], index: m.index, fullMatch: m[0] });
    }

    // 레이블 → 번호 매핑 (본문 등장 순서)
    const labelMap = {};
    let nextNum = 1;

    const sortedLabels = Object.keys(bodyRefs)
      .filter(function (l) { return !!footDefs[l]; })
      .sort(function (a, b) { return bodyRefs[a][0].index - bodyRefs[b][0].index; });

    for (let i = 0; i < sortedLabels.length; i++) {
      labelMap[sortedLabels[i]] = nextNum++;
    }

    // 인라인 각주 번호 부여
    for (let i = 0; i < inlines.length; i++) {
      inlines[i].number = nextNum++;
    }

    // 쌍 목록 생성
    const pairs = [];
    for (let i = 0; i < sortedLabels.length; i++) {
      const label = sortedLabels[i];
      const num = labelMap[label];
      const ref = bodyRefs[label][0];
      const start = Math.max(0, ref.index - 20);
      const end = Math.min(cleaned.length, ref.index + ref.fullMatch.length + 20);
      const bodyContext = cleaned.substring(start, end).replace(/<[^>]*>/g, '').trim();
      pairs.push({
        number: num,
        label: label,
        bodyContext: bodyContext,
        footContext: '[^' + label + ']: ' + footDefs[label].content,
        isInline: false,
        dupCount: bodyRefs[label].length,
      });
    }

    // 인라인 각주도 pairs에 추가
    for (let i = 0; i < inlines.length; i++) {
      var inl = inlines[i];
      var s = Math.max(0, inl.index - 20);
      var e = Math.min(cleaned.length, inl.index + inl.fullMatch.length + 20);
      var ctx = cleaned.substring(s, e).replace(/<[^>]*>/g, '').trim();
      pairs.push({
        number: inl.number,
        label: null,
        bodyContext: ctx,
        footContext: inl.content,
        isInline: true,
        dupCount: 1,
      });
    }

    pairs.sort(function (a, b) { return a.number - b.number; });

    // 고아 참조/정의
    const orphanRefs = Object.keys(bodyRefs).filter(function (l) { return !footDefs[l]; });
    const orphanDefs = Object.keys(footDefs).filter(function (l) { return !bodyRefs[l]; });

    // 이미 처리됨 확인
    const alreadyProcessed = pairs.length === 0 && inlines.length === 0 &&
      html.includes('id="_ftnref');

    return {
      pairs: pairs,
      orphanRefs: orphanRefs,
      orphanDefs: orphanDefs,
      labelMap: labelMap,
      inlines: inlines,
      alreadyProcessed: alreadyProcessed,
      format: 'markdown',
    };
  }

  // ─── 마크다운 각주 변환 ───

  function convertSingleMarkdownFootnote(html, label, number) {
    var result = stripProtectedZones(html);
    var text = result.cleaned;
    var zones = result.zones;

    if (label !== null) {
      var escaped = escapeRegex(label);
      var occurrence = 0;
      var bodyRe = new RegExp('\\[\\^' + escaped + '\\](?!\\s*:)', 'g');
      text = text.replace(bodyRe, function () {
        occurrence++;
        var idSuffix = occurrence > 1 ? '-' + occurrence : '';
        return '<sup><a id="_ftnref' + number + idSuffix + '" href="#_ftn' + number + '">[' + number + ']</a></sup>';
      });

      var defRe = new RegExp('\\[\\^' + escaped + '\\]:\\s*', 'g');
      text = text.replace(defRe,
        '<a id="_ftn' + number + '" href="#_ftnref' + number + '">[' + number + ']</a> '
      );
    }

    return restoreProtectedZones(text, zones);
  }

  function convertSingleInlineFootnote(html, number, scanResult) {
    var inlineIndex = -1;
    for (var i = 0; i < scanResult.inlines.length; i++) {
      if (scanResult.inlines[i].number === number) { inlineIndex = i; break; }
    }
    if (inlineIndex < 0) return html;

    var result = stripProtectedZones(html);
    var text = result.cleaned;
    var zones = result.zones;

    var count = 0;
    text = text.replace(/\^\[([^\]]+)\]/g, function (match, content) {
      if (count === inlineIndex) {
        count++;
        return '<sup><a id="_ftnref' + number + '" href="#_ftn' + number + '">[' + number + ']</a></sup>';
      }
      count++;
      return match;
    });

    var inlineContent = scanResult.inlines[inlineIndex].content;
    text += '\n<p><a id="_ftn' + number + '" href="#_ftnref' + number + '">[' + number + ']</a> ' + inlineContent + '</p>';

    return restoreProtectedZones(text, zones);
  }

  function convertAllMarkdownFootnotes(html, scanResult) {
    var labelMap = scanResult.labelMap;
    var inlines = scanResult.inlines;
    var result = stripProtectedZones(html);
    var text = result.cleaned;
    var zones = result.zones;

    // 1. 본문 참조 변환
    var labels = Object.keys(labelMap);
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      var num = labelMap[label];
      var escaped = escapeRegex(label);
      var occurrence = 0;
      var re = new RegExp('\\[\\^' + escaped + '\\](?!\\s*:)', 'g');
      text = text.replace(re, function () {
        occurrence++;
        var idSuffix = occurrence > 1 ? '-' + occurrence : '';
        return '<sup><a id="_ftnref' + num + idSuffix + '" href="#_ftn' + num + '">[' + num + ']</a></sup>';
      });
    }

    // 2. 정의 변환
    for (var j = 0; j < labels.length; j++) {
      var lbl = labels[j];
      var n = labelMap[lbl];
      var esc = escapeRegex(lbl);
      var defRe = new RegExp('\\[\\^' + esc + '\\]:\\s*', 'g');
      text = text.replace(defRe,
        '<a id="_ftn' + n + '" href="#_ftnref' + n + '">[' + n + ']</a> '
      );
    }

    // 3. 인라인 각주 변환
    var appendDefs = [];
    var inlineIdx = 0;
    text = text.replace(/\^\[([^\]]+)\]/g, function (match, content) {
      if (inlineIdx < inlines.length) {
        var inum = inlines[inlineIdx].number;
        inlineIdx++;
        appendDefs.push('<p><a id="_ftn' + inum + '" href="#_ftnref' + inum + '">[' + inum + ']</a> ' + content + '</p>');
        return '<sup><a id="_ftnref' + inum + '" href="#_ftn' + inum + '">[' + inum + ']</a></sup>';
      }
      return match;
    });

    if (appendDefs.length > 0) {
      text += '\n' + appendDefs.join('\n');
    }

    return restoreProtectedZones(text, zones);
  }

  // ─── 스캔 결과 저장 (format-aware dispatch에 사용) ───

  var lastScanResult = null;

  // ─── 메시지 리스너 ───

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    handleMessage(message).then(sendResponse);
    return true;
  });

  async function handleMessage(message) {
    try {
      var editorData = await getContent();

      if (!editorData) {
        return {
          error: 'editor_not_found',
          message: '편집기를 찾을 수 없습니다.\n티스토리 HTML 편집 모드인지 확인해주세요.',
        };
      }

      var html = editorData.content;

      switch (message.action) {
        case 'scan': {
          var format = detectFootnoteFormat(html);

          if (format === 'rendered') {
            lastScanResult = null;
            return {
              pairs: [],
              alreadyProcessed: true,
              editorType: editorData.type,
              totalPairs: 0,
              format: 'rendered',
              orphanRefs: [],
              orphanDefs: [],
            };
          }

          var scanResult;

          if (format === 'markdown') {
            var mdResult = detectMarkdownPairs(html);
            scanResult = mdResult;
            lastScanResult = { format: 'markdown', labelMap: mdResult.labelMap, inlines: mdResult.inlines, pairs: mdResult.pairs };
          } else if (format === 'mixed') {
            var wordResult = detectFootnotePairs(html);
            var mdResult2 = detectMarkdownPairs(html);

            // 마크다운 번호를 Word 최대 번호 이후부터 시작
            var maxWordNum = wordResult.pairs.reduce(function (mx, p) { return Math.max(mx, p.number); }, 0);
            for (var k = 0; k < mdResult2.pairs.length; k++) {
              mdResult2.pairs[k].number += maxWordNum;
            }
            var newLabelMap = {};
            for (var lbl in mdResult2.labelMap) {
              newLabelMap[lbl] = mdResult2.labelMap[lbl] + maxWordNum;
            }
            mdResult2.labelMap = newLabelMap;
            for (var ki = 0; ki < mdResult2.inlines.length; ki++) {
              mdResult2.inlines[ki].number += maxWordNum;
            }

            scanResult = {
              pairs: wordResult.pairs.concat(mdResult2.pairs),
              alreadyProcessed: wordResult.alreadyProcessed && mdResult2.alreadyProcessed,
              orphanRefs: mdResult2.orphanRefs || [],
              orphanDefs: mdResult2.orphanDefs || [],
              format: 'mixed',
            };
            lastScanResult = {
              format: 'mixed',
              wordResult: wordResult,
              mdResult: mdResult2,
            };
          } else if (format === 'word') {
            var wResult = detectFootnotePairs(html);
            scanResult = wResult;
            scanResult.format = 'word';
            lastScanResult = { format: 'word' };
          } else {
            scanResult = { pairs: [], alreadyProcessed: false, format: null };
            lastScanResult = null;
          }

          return {
            pairs: scanResult.pairs,
            alreadyProcessed: scanResult.alreadyProcessed,
            editorType: editorData.type,
            totalPairs: scanResult.pairs.length,
            format: scanResult.format || format,
            orphanRefs: scanResult.orphanRefs || [],
            orphanDefs: scanResult.orphanDefs || [],
          };
        }

        case 'convertOne': {
          var num = message.number;
          if (!lastScanResult) {
            return { error: 'no_scan', message: '먼저 스캔을 실행해주세요.' };
          }

          var newHtml;

          if (lastScanResult.format === 'word') {
            newHtml = convertSingleFootnote(html, num);
          } else if (lastScanResult.format === 'markdown') {
            var pair = null;
            for (var pi = 0; pi < lastScanResult.pairs.length; pi++) {
              if (lastScanResult.pairs[pi].number === num) { pair = lastScanResult.pairs[pi]; break; }
            }
            if (!pair) return { error: 'pair_not_found', message: '각주 ' + num + '번을 찾을 수 없습니다.' };

            if (pair.isInline) {
              newHtml = convertSingleInlineFootnote(html, num, lastScanResult);
            } else {
              newHtml = convertSingleMarkdownFootnote(html, pair.label, num);
            }
          } else if (lastScanResult.format === 'mixed') {
            var isWordPair = false;
            var wordPairs = (lastScanResult.wordResult && lastScanResult.wordResult.pairs) || [];
            for (var wi = 0; wi < wordPairs.length; wi++) {
              if (wordPairs[wi].number === num) { isWordPair = true; break; }
            }

            if (isWordPair) {
              newHtml = convertSingleFootnote(html, num);
            } else {
              var mdPairs = (lastScanResult.mdResult && lastScanResult.mdResult.pairs) || [];
              var mdPair = null;
              for (var mi = 0; mi < mdPairs.length; mi++) {
                if (mdPairs[mi].number === num) { mdPair = mdPairs[mi]; break; }
              }
              if (!mdPair) return { error: 'pair_not_found', message: '각주 ' + num + '번을 찾을 수 없습니다.' };

              if (mdPair.isInline) {
                newHtml = convertSingleInlineFootnote(html, num, lastScanResult.mdResult);
              } else {
                newHtml = convertSingleMarkdownFootnote(html, mdPair.label, num);
              }
            }
          } else {
            return { error: 'no_scan', message: '먼저 스캔을 실행해주세요.' };
          }

          await setContent(newHtml);
          return { success: true, number: num };
        }

        case 'convertAll': {
          if (!lastScanResult) {
            return { error: 'no_scan', message: '먼저 스캔을 실행해주세요.' };
          }

          var allHtml = html;
          var totalCount = 0;

          if (lastScanResult.format === 'word') {
            var wRes = detectFootnotePairs(html);
            allHtml = convertAllFootnotes(allHtml);
            totalCount = wRes.pairs.length;
          } else if (lastScanResult.format === 'markdown') {
            allHtml = convertAllMarkdownFootnotes(allHtml, lastScanResult);
            totalCount = lastScanResult.pairs.length;
          } else if (lastScanResult.format === 'mixed') {
            allHtml = convertAllFootnotes(allHtml);
            allHtml = convertAllMarkdownFootnotes(allHtml, lastScanResult.mdResult);
            totalCount = ((lastScanResult.wordResult && lastScanResult.wordResult.pairs) || []).length +
                         ((lastScanResult.mdResult && lastScanResult.mdResult.pairs) || []).length;
          }

          await setContent(allHtml);
          return { success: true, count: totalCount };
        }

        default:
          return { error: 'unknown_action', message: '알 수 없는 액션: ' + message.action };
      }
    } catch (err) {
      return {
        error: 'content_error',
        message: err.message,
      };
    }
  }
})();
