// 티스토리 각주 변환기 - 콘텐츠 스크립트
// 마지막으로 포커스된 편집 가능 요소를 추적하여 각주를 탐지/변환합니다.

(function () {
  'use strict';

  // ─── 마지막 포커스 요소 추적 ───

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

  // click 이벤트도 추적 (일부 에디터는 focusin이 안 올 수 있음)
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

  // ─── Page Bridge 통신 (CodeMirror 전용) ───

  let bridgeInjected = false;
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
        reject(new Error('CodeMirror 접근 시간 초과'));
      }, 5000);

      pendingRequests.set(id, (resp) => {
        clearTimeout(timeout);
        if (resp.error) {
          reject(new Error(resp.error));
        } else {
          resolve(resp);
        }
      });

      window.postMessage({ type: 'TISTORY_FN_REQUEST', id, action, value }, '*');
    });
  }

  // ─── 에디터 콘텐츠 읽기/쓰기 ───

  function resolveEditorElement() {
    const el = lastFocusedElement;
    if (!el) return null;

    // textarea
    const textarea = el.tagName === 'TEXTAREA' ? el : el.closest && el.closest('textarea');
    if (textarea) {
      return { type: 'textarea', element: textarea };
    }

    // contenteditable
    if (el.getAttribute && el.getAttribute('contenteditable') === 'true') {
      return { type: 'contenteditable', element: el };
    }
    const editableParent = el.closest && el.closest('[contenteditable="true"]');
    if (editableParent) {
      return { type: 'contenteditable', element: editableParent };
    }

    // CodeMirror 래퍼 내부 요소
    const cmWrapper = (el.closest && el.closest('.CodeMirror')) || (el.closest && el.closest('.cm-editor'));
    if (cmWrapper) {
      return { type: 'codemirror', element: cmWrapper };
    }

    return null;
  }

  async function getContent() {
    const editor = resolveEditorElement();
    if (!editor) return null;

    switch (editor.type) {
      case 'textarea':
        return { type: 'textarea', content: editor.element.value };

      case 'contenteditable':
        return { type: 'contenteditable', content: editor.element.innerHTML };

      case 'codemirror': {
        injectBridge();
        await new Promise((r) => setTimeout(r, 150));
        const resp = await sendToBridge('getValue');
        return { type: 'codemirror', content: resp.data };
      }

      default:
        return null;
    }
  }

  async function setContent(newContent) {
    const editor = resolveEditorElement();
    if (!editor) return false;

    switch (editor.type) {
      case 'textarea':
        editor.element.value = newContent;
        editor.element.dispatchEvent(new Event('input', { bubbles: true }));
        editor.element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;

      case 'contenteditable':
        editor.element.innerHTML = newContent;
        editor.element.dispatchEvent(new Event('input', { bubbles: true }));
        return true;

      case 'codemirror': {
        injectBridge();
        await new Promise((r) => setTimeout(r, 150));
        await sendToBridge('setValue', newContent);
        return true;
      }

      default:
        return false;
    }
  }

  // ─── 각주 탐지 ───

  const BODY_FOOTNOTE_RE = /<a\s+href="#_ftn(\d+)">\[(\d+)\]<\/a>/g;
  // <p>에 data-ke-size 같은 속성이 붙을 수 있으므로 [^>]* 로 처리
  const FOOT_DEFINITION_RE = /<p[^>]*><a\s+href="#_ftnref(\d+)">/g;

  function detectFootnotePairs(html) {
    if (html.includes('id="_ftnref')) {
      return { pairs: [], alreadyProcessed: true };
    }

    const bodyMatches = {};
    const footMatches = {};

    let m;
    BODY_FOOTNOTE_RE.lastIndex = 0;
    while ((m = BODY_FOOTNOTE_RE.exec(html)) !== null) {
      const num = m[1];
      const fullMatch = m[0];
      const start = Math.max(0, m.index - 30);
      const end = Math.min(html.length, m.index + fullMatch.length + 30);
      const context = html.substring(start, end).replace(/<[^>]*>/g, '').trim();
      bodyMatches[num] = { fullMatch, context, index: m.index };
    }

    FOOT_DEFINITION_RE.lastIndex = 0;
    while ((m = FOOT_DEFINITION_RE.exec(html)) !== null) {
      const num = m[1];
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

    return { pairs, alreadyProcessed: false };
  }

  // ─── 각주 변환 ───

  function convertSingleFootnote(html, number) {
    const n = number;

    const bodyRe = new RegExp(
      `<a\\s+href="#_ftn${n}">\\[${n}\\]</a>`,
      'g'
    );
    html = html.replace(
      bodyRe,
      `<sup><a id="_ftnref${n}" href="#_ftn${n}">[${n}]</a></sup>`
    );

    // <p> 태그에 data-ke-size 등 속성이 있을 수 있으므로 속성 보존
    const footRe = new RegExp(`<p([^>]*)><a href="#_ftnref${n}">`, 'g');
    html = html.replace(
      footRe,
      (match, attrs) => `<p${attrs} id="_ftn${n}"><a href="#_ftnref${n}">`
    );

    return html;
  }

  function convertAllFootnotes(html) {
    html = html.replace(
      /<a\s+href="#_ftn(\d+)">\[(\d+)\]<\/a>/g,
      '<sup><a id="_ftnref$1" href="#_ftn$1">[$2]</a></sup>'
    );

    // <p> 태그에 data-ke-size 등 속성이 있을 수 있으므로 속성 보존
    html = html.replace(
      /<p([^>]*)><a href="#_ftnref(\d+)">/g,
      (match, attrs, n) => `<p${attrs} id="_ftn${n}"><a href="#_ftnref${n}">`
    );

    return html;
  }

  // ─── 메시지 리스너 ───

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message).then(sendResponse);
    return true; // 비동기 응답
  });

  async function handleMessage(message) {
    try {
      const editorData = await getContent();

      if (!editorData) {
        return {
          error: 'editor_not_found',
          message: '편집 가능한 텍스트 영역을 찾을 수 없습니다.\nHTML 편집기를 클릭한 후 다시 시도해주세요.',
        };
      }

      const html = editorData.content;

      switch (message.action) {
        case 'scan': {
          const result = detectFootnotePairs(html);
          return {
            pairs: result.pairs,
            alreadyProcessed: result.alreadyProcessed,
            editorType: editorData.type,
            totalPairs: result.pairs.length,
          };
        }

        case 'convertOne': {
          const num = message.number;
          const newHtml = convertSingleFootnote(html, num);
          await setContent(newHtml);
          return { success: true, number: num };
        }

        case 'convertAll': {
          const result = detectFootnotePairs(html);
          const newHtml = convertAllFootnotes(html);
          await setContent(newHtml);
          return { success: true, count: result.pairs.length };
        }

        default:
          return { error: 'unknown_action', message: `알 수 없는 액션: ${message.action}` };
      }
    } catch (err) {
      return {
        error: 'content_error',
        message: err.message,
      };
    }
  }
})();
