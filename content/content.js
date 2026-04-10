// 티스토리 각주 변환기 - 콘텐츠 스크립트
// 티스토리 HTML 편집기의 콘텐츠에 접근하여 각주 패턴을 탐지하고 변환합니다.

(function () {
  'use strict';

  // ─── 에디터 접근 ───

  function getEditorAccess() {
    // 1. CodeMirror 6
    const cm6El = document.querySelector('.cm-editor');
    if (cm6El) {
      const view = cm6El.cmView && cm6El.cmView.view;
      if (view) {
        return {
          type: 'cm6',
          getContent: () => view.state.doc.toString(),
          setContent: (text) => {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: text },
            });
          },
        };
      }
    }

    // 2. CodeMirror 5
    const cm5El = document.querySelector('.CodeMirror');
    if (cm5El && cm5El.CodeMirror) {
      const cm = cm5El.CodeMirror;
      return {
        type: 'cm5',
        getContent: () => cm.getValue(),
        setContent: (text) => cm.setValue(text),
      };
    }

    // 3. textarea 폴백 (여러 셀렉터 시도)
    const textareaSelectors = [
      '#content',
      'textarea[name="content"]',
      '.html-mode textarea',
      '.editor-html textarea',
      '#editor-html textarea',
      'textarea.html-editor',
      'textarea',
    ];
    for (const sel of textareaSelectors) {
      const textarea = document.querySelector(sel);
      if (textarea && textarea.tagName === 'TEXTAREA') {
        return {
          type: 'textarea',
          getContent: () => textarea.value,
          setContent: (text) => {
            textarea.value = text;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
          },
        };
      }
    }

    // 4. contenteditable 폴백
    const editableSelectors = [
      '.html-mode [contenteditable="true"]',
      '.editor-html [contenteditable="true"]',
      '[contenteditable="true"]',
    ];
    for (const sel of editableSelectors) {
      const editable = document.querySelector(sel);
      if (editable) {
        return {
          type: 'contenteditable',
          getContent: () => editable.innerHTML,
          setContent: (text) => {
            editable.innerHTML = text;
            editable.dispatchEvent(new Event('input', { bubbles: true }));
          },
        };
      }
    }

    // 5. iframe 내부 에디터 탐색
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const iDoc = iframe.contentDocument || iframe.contentWindow.document;
        const iTextarea = iDoc.querySelector('textarea');
        if (iTextarea) {
          return {
            type: 'iframe-textarea',
            getContent: () => iTextarea.value,
            setContent: (text) => {
              iTextarea.value = text;
              iTextarea.dispatchEvent(new Event('input', { bubbles: true }));
              iTextarea.dispatchEvent(new Event('change', { bubbles: true }));
            },
          };
        }
        const iEditable = iDoc.querySelector('[contenteditable="true"]');
        if (iEditable) {
          return {
            type: 'iframe-contenteditable',
            getContent: () => iEditable.innerHTML,
            setContent: (text) => {
              iEditable.innerHTML = text;
              iEditable.dispatchEvent(new Event('input', { bubbles: true }));
            },
          };
        }
      } catch (e) {
        // cross-origin iframe — skip
      }
    }

    return null;
  }

  // ─── 각주 탐지 ───

  // 본문 각주 패턴: <a href="#_ftnN">[N]</a> (아직 id="_ftnref" 없는 것)
  const BODY_FOOTNOTE_RE = /<a\s+href="#_ftn(\d+)">\[(\d+)\]<\/a>/g;
  // 하단 각주 패턴: <p><a href="#_ftnrefN"> (아직 <p id="_ftn"> 없는 것)
  const FOOT_DEFINITION_RE = /<p><a\s+href="#_ftnref(\d+)">/g;

  function detectFootnotePairs(html) {
    // 이미 처리된 경우
    if (html.includes('id="_ftnref')) {
      return { pairs: [], alreadyProcessed: true };
    }

    const bodyMatches = {};
    const footMatches = {};

    // 본문 각주 참조 수집
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

    // 하단 각주 정의 수집
    FOOT_DEFINITION_RE.lastIndex = 0;
    while ((m = FOOT_DEFINITION_RE.exec(html)) !== null) {
      const num = m[1];
      const fullMatch = m[0];
      const start = m.index;
      const end = Math.min(html.length, m.index + 100);
      const snippet = html.substring(start, end);
      // </p> 또는 다음 줄까지 잘라서 컨텍스트 추출
      const pEnd = snippet.indexOf('</p>');
      const contextRaw = pEnd > 0 ? snippet.substring(0, pEnd) : snippet;
      const context = contextRaw.replace(/<[^>]*>/g, '').trim();
      footMatches[num] = { fullMatch, context, index: m.index };
    }

    // 본문+하단 쌍 매칭
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

    // 본문: <a href="#_ftnN">[N]</a> → <sup><a id="_ftnrefN" href="#_ftnN">[N]</a></sup>
    const bodyRe = new RegExp(
      `<a\\s+href="#_ftn${n}">\\[${n}\\]</a>`,
      'g'
    );
    html = html.replace(
      bodyRe,
      `<sup><a id="_ftnref${n}" href="#_ftn${n}">[${n}]</a></sup>`
    );

    // 하단: <p><a href="#_ftnrefN"> → <p id="_ftnN"><a href="#_ftnrefN">
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
    // 본문 각주 일괄 변환
    html = html.replace(
      /<a\s+href="#_ftn(\d+)">\[(\d+)\]<\/a>/g,
      '<sup><a id="_ftnref$1" href="#_ftn$1">[$2]</a></sup>'
    );

    // 하단 각주 일괄 변환
    html = html.replace(
      /<p><a href="#_ftnref(\d+)">/g,
      '<p id="_ftn$1"><a href="#_ftnref$1">'
    );

    return html;
  }

  // ─── 메시지 리스너 ───

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const editor = getEditorAccess();

    if (!editor) {
      sendResponse({
        error: 'editor_not_found',
        message: 'HTML 편집기를 찾을 수 없습니다. HTML 편집 모드인지 확인해주세요.',
      });
      return true;
    }

    const html = editor.getContent();

    switch (message.action) {
      case 'scan': {
        const result = detectFootnotePairs(html);
        sendResponse({
          pairs: result.pairs,
          alreadyProcessed: result.alreadyProcessed,
          editorType: editor.type,
          totalPairs: result.pairs.length,
        });
        break;
      }

      case 'convertOne': {
        const num = message.number;
        const newHtml = convertSingleFootnote(html, num);
        editor.setContent(newHtml);
        sendResponse({ success: true, number: num });
        break;
      }

      case 'convertAll': {
        const newHtml = convertAllFootnotes(html);
        editor.setContent(newHtml);
        const result = detectFootnotePairs(html);
        sendResponse({ success: true, count: result.pairs.length });
        break;
      }

      default:
        sendResponse({ error: 'unknown_action', message: `알 수 없는 액션: ${message.action}` });
    }

    return true;
  });
})();
