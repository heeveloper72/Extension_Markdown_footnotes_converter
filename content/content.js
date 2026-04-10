// 티스토리 각주 변환기 - 콘텐츠 스크립트
// isolated world에서 실행됩니다.
// CodeMirror 등 페이지 JS 객체 접근은 page-bridge.js를 통해 수행합니다.

(function () {
  'use strict';

  // ─── Page Bridge 통신 ───

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
        reject(new Error('페이지 브릿지 응답 시간 초과'));
      }, 5000);

      pendingRequests.set(id, (resp) => {
        clearTimeout(timeout);
        if (resp.error) {
          reject(new Error(resp.error === 'EDITOR_NOT_FOUND'
            ? 'HTML 편집기를 찾을 수 없습니다. HTML 편집 모드인지 확인해주세요.'
            : resp.error));
        } else {
          resolve(resp);
        }
      });

      window.postMessage({ type: 'TISTORY_FN_REQUEST', id, action, value }, '*');
    });
  }

  // ─── 각주 탐지 ───

  const BODY_FOOTNOTE_RE = /<a\s+href="#_ftn(\d+)">\[(\d+)\]<\/a>/g;
  const FOOT_DEFINITION_RE = /<p><a\s+href="#_ftnref(\d+)">/g;

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

    const footRe = new RegExp(
      `<p><a href="#_ftnref${n}">`,
      'g'
    );
    html = html.replace(
      footRe,
      `<p id="_ftn${n}"><a href="#_ftnref${n}">`
    );

    return html;
  }

  function convertAllFootnotes(html) {
    html = html.replace(
      /<a\s+href="#_ftn(\d+)">\[(\d+)\]<\/a>/g,
      '<sup><a id="_ftnref$1" href="#_ftn$1">[$2]</a></sup>'
    );

    html = html.replace(
      /<p><a href="#_ftnref(\d+)">/g,
      '<p id="_ftn$1"><a href="#_ftnref$1">'
    );

    return html;
  }

  // ─── 메시지 리스너 ───

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    injectBridge();

    // 브릿지가 로드될 약간의 시간을 줌
    setTimeout(() => {
      handleMessage(message, sendResponse);
    }, 100);

    return true; // 비동기 응답
  });

  async function handleMessage(message, sendResponse) {
    try {
      const resp = await sendToBridge('getValue');
      const html = resp.data;
      const editorType = resp.editorType;

      switch (message.action) {
        case 'scan': {
          const result = detectFootnotePairs(html);
          sendResponse({
            pairs: result.pairs,
            alreadyProcessed: result.alreadyProcessed,
            editorType,
            totalPairs: result.pairs.length,
          });
          break;
        }

        case 'convertOne': {
          const num = message.number;
          const newHtml = convertSingleFootnote(html, num);
          await sendToBridge('setValue', newHtml);
          sendResponse({ success: true, number: num });
          break;
        }

        case 'convertAll': {
          const result = detectFootnotePairs(html);
          const newHtml = convertAllFootnotes(html);
          await sendToBridge('setValue', newHtml);
          sendResponse({ success: true, count: result.pairs.length });
          break;
        }

        default:
          sendResponse({ error: 'unknown_action', message: `알 수 없는 액션: ${message.action}` });
      }
    } catch (err) {
      sendResponse({
        error: 'bridge_error',
        message: err.message,
      });
    }
  }
})();
