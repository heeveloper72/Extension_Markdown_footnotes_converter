// 티스토리 각주 변환기 - 콘텐츠 스크립트

(function () {
  'use strict';

  // ─── 중복 실행 방지 ───
  // popup이 executeScript로 재주입할 때 리스너 중복 등록 방지
  if (window.__tistoryFnConverterLoaded) return;
  window.__tistoryFnConverterLoaded = true;

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

    // 평문 [N] 감지 — 클러스터 기반 (티스토리가 [^N]을 [N]으로 변환한 경우)
    var ptCluster = detectPlainTextCluster(cleaned);
    if (ptCluster && ptCluster.definitions.size >= 2) return 'plaintext';

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

  // ─── 평문 [N] 각주 — 클러스터 기반 탐지 ───

  /**
   * 문서 하단에서 <p>[N]  내용</p> 형태의 정의 클러스터를 찾는다.
   * 반환: { definitions: Map<number, {index, content}>, clusterStart, numbers } 또는 null
   */
  function detectPlainTextCluster(html) {
    // 정의 패턴: <p> 다음에 [N]과 2개 이상 공백 (티스토리가 [^N]: 를 변환한 결과)
    var defRe = /<p[^>]*>\[(\d+)\]\s{2,}/g;
    var defs = [];
    var m;
    while ((m = defRe.exec(html)) !== null) {
      var num = parseInt(m[1], 10);
      // 정의 내용 추출 (</p>까지)
      var afterIdx = m.index + m[0].length;
      var rest = html.substring(afterIdx);
      var pEnd = rest.indexOf('</p>');
      var rawContent = pEnd >= 0 ? rest.substring(0, pEnd) : rest.substring(0, 100);
      var content = rawContent.replace(/<[^>]*>/g, '').trim();
      defs.push({ num: num, index: m.index, content: content });
    }

    if (defs.length < 2) return null;

    // 클러스터 검증: 모든 정의가 문서 후반부에 모여있는지
    var docLen = html.length;
    var clusterStart = defs[0].index;
    // 클러스터는 문서 50% 이후에 시작해야 함
    if (clusterStart < docLen * 0.3) return null;

    // 번호 집합 완전성 검증: 1부터 max까지 빠짐 없이 존재
    var numbers = new Set();
    for (var i = 0; i < defs.length; i++) {
      numbers.add(defs[i].num);
    }
    var maxNum = 0;
    numbers.forEach(function (n) { if (n > maxNum) maxNum = n; });

    // 1~max 사이에 빠진 번호가 있으면 클러스터가 아닐 가능성
    var missing = [];
    for (var n = 1; n <= maxNum; n++) {
      if (!numbers.has(n)) missing.push(n);
    }
    // 빠진 번호가 전체의 20% 이상이면 클러스터가 아닌 것으로 판단
    if (missing.length > maxNum * 0.2) return null;

    var definitions = new Map();
    for (var j = 0; j < defs.length; j++) {
      definitions.set(defs[j].num, { index: defs[j].index, content: defs[j].content });
    }

    return { definitions: definitions, clusterStart: clusterStart, numbers: numbers, maxNum: maxNum, missing: missing };
  }

  /**
   * 평문 [N] 각주 쌍 탐지
   */
  function detectPlainTextPairs(html) {
    var result = stripProtectedZones(html);
    var cleaned = result.cleaned;

    var cluster = detectPlainTextCluster(cleaned);
    if (!cluster || cluster.definitions.size < 2) {
      return { pairs: [], alreadyProcessed: false, format: null };
    }

    // 이미 변환 완료 확인
    if (cleaned.includes('id="_ftnref')) {
      return { pairs: [], alreadyProcessed: true, format: 'plaintext' };
    }

    // 본문 참조 탐지: 클러스터 시작 이전 영역에서 [N] 찾기
    // <p> 직후가 아닌 위치 (정의와 구분)
    var bodyArea = cleaned.substring(0, cluster.clusterStart);
    var bodyRefs = {};
    // [N] 패턴 — <p> 직후나 줄 시작이 아닌 곳에서만 (본문 참조)
    var refRe = /\[(\d+)\]/g;
    var rm;
    while ((rm = refRe.exec(bodyArea)) !== null) {
      var rNum = parseInt(rm[1], 10);
      // 클러스터에 정의가 있는 번호만 채택
      if (!cluster.definitions.has(rNum)) continue;
      // <p> 직후인지 확인 (정의 패턴 배제)
      var before = bodyArea.substring(Math.max(0, rm.index - 20), rm.index);
      if (/<p[^>]*>\s*$/.test(before)) continue;

      if (!bodyRefs[rNum]) {
        var start = Math.max(0, rm.index - 30);
        var end = Math.min(bodyArea.length, rm.index + rm[0].length + 30);
        var ctx = bodyArea.substring(start, end).replace(/<[^>]*>/g, '').trim();
        bodyRefs[rNum] = { index: rm.index, context: ctx };
      }
    }

    // 쌍 생성
    var pairs = [];
    var nums = [];
    cluster.definitions.forEach(function (val, key) { nums.push(key); });
    nums.sort(function (a, b) { return a - b; });

    for (var i = 0; i < nums.length; i++) {
      var n = nums[i];
      var def = cluster.definitions.get(n);
      var bodyRef = bodyRefs[n];

      pairs.push({
        number: n,
        bodyContext: bodyRef ? bodyRef.context : '(본문 참조 미발견)',
        footContext: '[' + n + ']  ' + def.content,
        hasBodyRef: !!bodyRef,
      });
    }

    // 고아 정보
    var orphanDefs = [];
    for (var oi = 0; oi < nums.length; oi++) {
      if (!bodyRefs[nums[oi]]) orphanDefs.push(String(nums[oi]));
    }

    return {
      pairs: pairs,
      alreadyProcessed: false,
      format: 'plaintext',
      cluster: cluster,
      orphanRefs: [],
      orphanDefs: orphanDefs,
    };
  }

  // ─── 평문 [N] 각주 변환 ───

  function convertSinglePlainTextFootnote(html, number) {
    var n = number;

    // 클러스터를 다시 찾아서 정확한 위치에서 변환
    var cluster = detectPlainTextCluster(html);
    if (!cluster) return html;

    // 1. 본문 참조 변환: 클러스터 이전 영역의 [N] → <sup><a ...>[N]</a></sup>
    var bodyArea = html.substring(0, cluster.clusterStart);
    var replaced = false;
    var bodyResult = bodyArea.replace(/\[(\d+)\]/g, function (match, numStr, offset) {
      if (replaced) return match;
      if (parseInt(numStr, 10) !== n) return match;
      // <p> 직후 배제
      var before = bodyArea.substring(Math.max(0, offset - 20), offset);
      if (/<p[^>]*>\s*$/.test(before)) return match;
      replaced = true;
      return '<sup><a id="_ftnref' + n + '" href="#_ftn' + n + '">[' + n + ']</a></sup>';
    });

    // 2. 정의 변환: <p>[N]  → <p><a id="_ftn...">[N]</a>
    var footArea = html.substring(cluster.clusterStart);
    var defRe = new RegExp('<p([^>]*)>\\[' + n + '\\](\\s{2,})', 'g');
    footArea = footArea.replace(defRe, function (match, attrs, spaces) {
      return '<p' + attrs + '><a id="_ftn' + n + '" href="#_ftnref' + n + '">[' + n + ']</a>' + spaces;
    });

    return bodyResult + footArea;
  }

  function convertAllPlainTextFootnotes(html, scanResult) {
    var cluster = scanResult.cluster;
    if (!cluster) return html;

    // 1. 본문 참조 일괄 변환
    var bodyArea = html.substring(0, cluster.clusterStart);
    bodyArea = bodyArea.replace(/\[(\d+)\]/g, function (match, numStr, offset) {
      var num = parseInt(numStr, 10);
      if (!cluster.definitions.has(num)) return match;
      // <p> 직후 배제
      var before = bodyArea.substring(Math.max(0, offset - 20), offset);
      if (/<p[^>]*>\s*$/.test(before)) return match;
      return '<sup><a id="_ftnref' + num + '" href="#_ftn' + num + '">[' + num + ']</a></sup>';
    });

    // 2. 정의 일괄 변환
    var footArea = html.substring(cluster.clusterStart);
    footArea = footArea.replace(/<p([^>]*)>\[(\d+)\](\s{2,})/g, function (match, attrs, numStr, spaces) {
      var num = parseInt(numStr, 10);
      if (!cluster.definitions.has(num)) return match;
      return '<p' + attrs + '><a id="_ftn' + num + '" href="#_ftnref' + num + '">[' + num + ']</a>' + spaces;
    });

    return bodyArea + footArea;
  }

  // ─── 스캔 결과 저장 (format-aware dispatch에 사용) ───

  var lastScanResult = null;

  // ─── 마크다운 편집 모드 감지 ───

  function isLikelyRawMarkdown(content) {
    if (!content || content.length < 10) return false;
    // 티스토리 HTML 모드는 반드시 <p 태그를 포함
    var hasPTag = /<p[\s>]/.test(content);
    var hasDivTag = /<div[\s>]/.test(content);
    if (hasPTag || hasDivTag) return false;
    // 마크다운 특유 패턴 확인
    var mdIndicators = 0;
    if (/^#{1,6}\s/m.test(content)) mdIndicators++;
    if (/\[.+\]\(.+\)/.test(content)) mdIndicators++;
    if (/^\s*[-*]\s/m.test(content)) mdIndicators++;
    if (/^\s*\d+\.\s/m.test(content)) mdIndicators++;
    if (/```/.test(content)) mdIndicators++;
    return mdIndicators >= 1;
  }

  // ─── MathJax 부트스트랩 ───

  var MATHJAX_BOOTSTRAP = '<script>\n' +
    '(function(){\n' +
    '  if(window.__mathjaxInjected)return;\n' +
    '  window.__mathjaxInjected=true;\n' +
    '  window.MathJax={\n' +
    '    tex:{\n' +
    '      inlineMath:[[\'$\',\'$\'],[\'\\\\(\',\'\\\\)\']],\n' +
    '      displayMath:[[\'$$\',\'$$\'],[\'\\\\[\',\'\\\\]\']],\n' +
    '      processEscapes:true,\n' +
    '      tags:\'ams\'\n' +
    '    },\n' +
    '    options:{\n' +
    '      skipHtmlTags:[\'script\',\'noscript\',\'style\',\'textarea\',\'pre\',\'code\']\n' +
    '    }\n' +
    '  };\n' +
    '  var s=document.createElement(\'script\');\n' +
    '  s.id=\'MathJax-script\';\n' +
    '  s.async=true;\n' +
    '  s.src=\'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js\';\n' +
    '  document.head.appendChild(s);\n' +
    '})();\n' +
    '</script>';

  function needsMath(html) {
    var result = stripProtectedZones(html);
    var cleaned = result.cleaned;
    // Remove existing <script> tags
    cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, '');
    if (/\$\$[\s\S]+?\$\$/.test(cleaned)) return true;
    if (/\$[^$\n]+?\$/.test(cleaned)) return true;
    if (/\\\([\s\S]+?\\\)/.test(cleaned)) return true;
    if (/\\\[[\s\S]+?\\\]/.test(cleaned)) return true;
    return false;
  }

  function alreadyHasMath(html) {
    if (/MathJax/i.test(html)) return true;
    if (/katex/i.test(html)) return true;
    if (/tex-mml-chtml/i.test(html)) return true;
    if (/__mathjaxInjected/.test(html)) return true;
    return false;
  }

  function looksLikeMath(content) {
    if (/[\\^_{}]/.test(content)) return true;
    var kw = /(?:frac|sqrt|sum|prod|int|lim|alpha|beta|gamma|delta|theta|lambda|sigma|pi|infty|partial|nabla|cdot|times|div|pm|leq|geq|neq|approx|equiv|sim|text|mathbb|overline|vec|dot|bar|begin|end|matrix)/i;
    if (kw.test(content)) return true;
    return false;
  }

  function countMathExpressions(html) {
    var result = stripProtectedZones(html);
    var cleaned = result.cleaned;
    cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, '');
    var display = (cleaned.match(/\$\$[\s\S]+?\$\$/g) || []).length;
    var temp = cleaned.replace(/\$\$[\s\S]+?\$\$/g, '');
    var inline = 0;
    var re = /\$([^$\n]+?)\$/g;
    var m;
    while ((m = re.exec(temp)) !== null) {
      if (looksLikeMath(m[1])) inline++;
    }
    return { display: display, inline: inline, total: display + inline };
  }

  function escapeCurrencyDollars(html) {
    var result = stripProtectedZones(html);
    var text = result.cleaned;
    var zones = result.zones;
    var escapeCount = 0;

    // Protect existing <script> tags
    var scriptZones = [];
    var szIdx = 0;
    text = text.replace(/<script[\s\S]*?<\/script>/gi, function (m) {
      var ph = '\x00SZ' + (szIdx++) + '\x00';
      scriptZones.push({ ph: ph, content: m });
      return ph;
    });

    // Pass 1: Protect $$...$$ display math
    var mathZones = [];
    var mzIdx = 0;
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, function (m) {
      var ph = '\x00MZ' + (mzIdx++) + '\x00';
      mathZones.push({ ph: ph, content: m });
      return ph;
    });

    // Pass 2: Protect $...$ inline math with LaTeX indicators
    text = text.replace(/\$([^$\n]+?)\$/g, function (match, content) {
      if (looksLikeMath(content)) {
        var ph = '\x00MZ' + (mzIdx++) + '\x00';
        mathZones.push({ ph: ph, content: match });
        return ph;
      }
      return match;
    });

    // Pass 3: Escape remaining $ followed by digit (currency)
    text = text.replace(/(?<!\\)\$(?=\d)/g, function () {
      escapeCount++;
      return '\\$';
    });

    // Restore (reverse order)
    for (var i = 0; i < mathZones.length; i++) {
      text = text.split(mathZones[i].ph).join(mathZones[i].content);
    }
    for (var j = 0; j < scriptZones.length; j++) {
      text = text.split(scriptZones[j].ph).join(scriptZones[j].content);
    }
    text = restoreProtectedZones(text, zones);

    return { escaped: text, escapeCount: escapeCount };
  }

  function findAmbiguousDollars(html) {
    var result = stripProtectedZones(html);
    var text = result.cleaned;

    // Remove <script> tags
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '');

    // Remove $$...$$ (always math)
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, function (m) {
      return '\x00DD' + '\x00'.repeat(m.length - 4) + '\x00DD\x00';
    });

    // Remove confirmed math $...$ (LaTeX indicators)
    text = text.replace(/\$([^$\n]+?)\$/g, function (match, content) {
      if (looksLikeMath(content)) {
        return '\x00IM' + '\x00'.repeat(match.length - 4) + '\x00IM\x00';
      }
      return match;
    });

    // Find remaining $ patterns
    var items = [];
    var re = /(?<!\\)\$/g;
    var m;
    var dollarPositions = [];
    while ((m = re.exec(text)) !== null) {
      dollarPositions.push(m.index);
    }

    var stripTags = function (s) {
      return s.replace(/<[^>]*>/g, '').replace(/\x00[A-Z]*\x00/g, '');
    };

    for (var i = 0; i < dollarPositions.length; i++) {
      var pos = dollarPositions[i];
      var start = Math.max(0, pos - 30);
      var end = Math.min(text.length, pos + 31);
      var contextBefore = stripTags(text.substring(start, pos));
      var contextAfter = stripTags(text.substring(pos + 1, end));

      // Auto-classify
      var after = text.substring(pos + 1, Math.min(text.length, pos + 20));
      var autoClass = 'ambiguous';
      if (/^\d/.test(after)) {
        autoClass = 'currency';
      }

      items.push({
        index: pos,
        contextBefore: contextBefore,
        contextAfter: contextAfter,
        autoClassification: autoClass,
      });
    }

    return items;
  }

  function applyDollarClassifications(html, classifications) {
    if (!classifications || classifications.length === 0) return html;

    var result = stripProtectedZones(html);
    var text = result.cleaned;
    var zones = result.zones;

    // Build set of positions to escape
    var escapePositions = new Set();
    for (var i = 0; i < classifications.length; i++) {
      if (classifications[i].type === 'currency') {
        escapePositions.add(classifications[i].index);
      }
    }

    // Remove <script> to recalculate positions consistently
    var scriptZones = [];
    var szIdx = 0;
    text = text.replace(/<script[\s\S]*?<\/script>/gi, function (m) {
      var ph = '\x00SZ' + (szIdx++) + '\x00';
      scriptZones.push({ ph: ph, content: m });
      return ph;
    });

    // Remove $$...$$
    var mathZones = [];
    var mzIdx = 0;
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, function (m) {
      var ph = '\x00MZ' + (mzIdx++) + '\x00';
      mathZones.push({ ph: ph, content: m });
      return ph;
    });

    // Remove confirmed math $...$
    text = text.replace(/\$([^$\n]+?)\$/g, function (match, content) {
      if (looksLikeMath(content)) {
        var ph = '\x00MZ' + (mzIdx++) + '\x00';
        mathZones.push({ ph: ph, content: match });
        return ph;
      }
      return match;
    });

    // Replace $ at classified positions
    var chars = text.split('');
    var re = /(?<!\\)\$/g;
    var m;
    var matches = [];
    while ((m = re.exec(text)) !== null) {
      matches.push(m.index);
    }

    // Map remaining $ positions to classification indices
    for (var ci = 0; ci < matches.length; ci++) {
      if (escapePositions.has(matches[ci])) {
        chars[matches[ci]] = '\\$';
      }
    }
    text = chars.join('');

    // Restore
    for (var ri = 0; ri < mathZones.length; ri++) {
      text = text.split(mathZones[ri].ph).join(mathZones[ri].content);
    }
    for (var si = 0; si < scriptZones.length; si++) {
      text = text.split(scriptZones[si].ph).join(scriptZones[si].content);
    }
    text = restoreProtectedZones(text, zones);

    return text;
  }

  // ─── 변환 결과 검증 ───

  function verifyConversion(html) {
    var issues = [];

    var ftnrefRe = /id="_ftnref(\d+)"/g;
    var ftnRe = /id="_ftn(\d+)"/g;
    var refNums = new Set();
    var defNums = new Set();

    var m;
    while ((m = ftnrefRe.exec(html)) !== null) refNums.add(m[1]);
    while ((m = ftnRe.exec(html)) !== null) defNums.add(m[1]);

    refNums.forEach(function (n) {
      if (!defNums.has(n)) issues.push('[' + n + '] 본문 참조 O, 정의 X');
    });
    defNums.forEach(function (n) {
      if (!refNums.has(n)) issues.push('[' + n + '] 정의 O, 본문 참조 X');
    });

    // target 속성 자동 추가 감지
    if (/id="_ftn(?:ref)?\d+"[^>]*target\s*=/i.test(html)) {
      issues.push('에디터가 앵커에 target 속성을 자동 추가함');
    }

    // href 변조 감지 (상대경로 → 절대경로 변환 등)
    var hrefCheck = /id="_ftnref(\d+)"[^>]*href="([^"]*)"/g;
    while ((m = hrefCheck.exec(html)) !== null) {
      if (m[2] !== '#_ftn' + m[1]) {
        issues.push('[' + m[1] + '] href 변조: ' + m[2]);
      }
    }

    return {
      refCount: refNums.size,
      defCount: defNums.size,
      issues: issues,
      ok: issues.length === 0,
    };
  }

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

      // 마크다운 편집 모드 감지
      if (isLikelyRawMarkdown(html)) {
        return {
          error: 'markdown_mode',
          message: '마크다운 편집 모드가 감지되었습니다.\nHTML 편집 모드로 전환 후 다시 시도해주세요.\n\n(마크다운 모드에서 변환하면 HTML이 깨질 수 있습니다)',
        };
      }

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
          } else if (format === 'plaintext') {
            var ptResult = detectPlainTextPairs(html);
            scanResult = ptResult;
            lastScanResult = { format: 'plaintext', cluster: ptResult.cluster, pairs: ptResult.pairs };
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
          } else if (lastScanResult.format === 'plaintext') {
            newHtml = convertSinglePlainTextFootnote(html, num);
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

          // 변환 후 검증: 에디터에 실제 반영된 내용 확인
          var verifyData = await getContent();
          var verification = verifyData ? verifyConversion(verifyData.content) : null;

          return { success: true, number: num, verification: verification };
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
          } else if (lastScanResult.format === 'plaintext') {
            allHtml = convertAllPlainTextFootnotes(allHtml, lastScanResult);
            totalCount = lastScanResult.pairs.length;
          } else if (lastScanResult.format === 'mixed') {
            allHtml = convertAllFootnotes(allHtml);
            allHtml = convertAllMarkdownFootnotes(allHtml, lastScanResult.mdResult);
            totalCount = ((lastScanResult.wordResult && lastScanResult.wordResult.pairs) || []).length +
                         ((lastScanResult.mdResult && lastScanResult.mdResult.pairs) || []).length;
          }

          await setContent(allHtml);

          // 변환 후 검증
          var verifyData2 = await getContent();
          var verification2 = verifyData2 ? verifyConversion(verifyData2.content) : null;

          return { success: true, count: totalCount, verification: verification2 };
        }

        case 'scanMath': {
          var hasMath = needsMath(html);
          var already = alreadyHasMath(html);
          var mathCounts = hasMath ? countMathExpressions(html) : { display: 0, inline: 0, total: 0 };

          var dollarItems = [];
          if (hasMath && !already) {
            dollarItems = findAmbiguousDollars(html);
          }

          return {
            hasMath: hasMath,
            alreadyHasMath: already,
            mathCounts: mathCounts,
            dollarItems: dollarItems,
          };
        }

        case 'applyMath': {
          var classifications = message.classifications || [];

          var newMathHtml = applyDollarClassifications(html, classifications);

          if (!alreadyHasMath(newMathHtml)) {
            newMathHtml = MATHJAX_BOOTSTRAP + '\n' + newMathHtml;
          }

          await setContent(newMathHtml);

          var mathVerifyData = await getContent();
          var mathVerified = mathVerifyData ? alreadyHasMath(mathVerifyData.content) : false;

          return {
            success: true,
            verified: mathVerified,
            currencyEscaped: classifications.filter(function (c) { return c.type === 'currency'; }).length,
            mathKept: classifications.filter(function (c) { return c.type === 'math'; }).length,
          };
        }

        case 'applyMathAll': {
          var escResult = escapeCurrencyDollars(html);
          var mathAllHtml = escResult.escaped;

          if (!alreadyHasMath(mathAllHtml)) {
            mathAllHtml = MATHJAX_BOOTSTRAP + '\n' + mathAllHtml;
          }

          await setContent(mathAllHtml);

          var mathAllVerify = await getContent();
          var mathAllVerified = mathAllVerify ? alreadyHasMath(mathAllVerify.content) : false;

          return {
            success: true,
            verified: mathAllVerified,
            currencyEscaped: escResult.escapeCount,
            mathCounts: countMathExpressions(mathAllHtml),
          };
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
