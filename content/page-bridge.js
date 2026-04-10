// 티스토리 각주 변환기 - 페이지 컨텍스트 브릿지
// Content script는 isolated world에서 실행되어 CodeMirror 인스턴스에 직접 접근 불가.
// 이 스크립트는 페이지 컨텍스트에 주입되어 에디터 API에 접근합니다.

(function () {
  'use strict';

  function getEditor() {
    // CodeMirror 5
    const cm5 = document.querySelector('.CodeMirror');
    if (cm5 && cm5.CodeMirror) {
      return {
        type: 'cm5',
        getValue: () => cm5.CodeMirror.getValue(),
        setValue: (v) => cm5.CodeMirror.setValue(v),
      };
    }

    // CodeMirror 6
    const cm6 = document.querySelector('.cm-editor');
    if (cm6 && cm6.cmView && cm6.cmView.view) {
      const view = cm6.cmView.view;
      return {
        type: 'cm6',
        getValue: () => view.state.doc.toString(),
        setValue: (v) => {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: v },
          });
        },
      };
    }

    // textarea 폴백
    const selectors = [
      '#content',
      'textarea[name="content"]',
      '.html-mode textarea',
      '.editor-html textarea',
      '#editor-html textarea',
      'textarea.html-editor',
      'textarea',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.tagName === 'TEXTAREA') {
        return {
          type: 'textarea',
          getValue: () => el.value,
          setValue: (v) => {
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          },
        };
      }
    }

    // contenteditable 폴백
    const editableSelectors = [
      '.html-mode [contenteditable="true"]',
      '.editor-html [contenteditable="true"]',
      '[contenteditable="true"]',
    ];
    for (const sel of editableSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        return {
          type: 'contenteditable',
          getValue: () => el.innerHTML,
          setValue: (v) => {
            el.innerHTML = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          },
        };
      }
    }

    return null;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'TISTORY_FN_REQUEST') return;

    const { id, action, value } = event.data;
    const editor = getEditor();

    if (!editor) {
      window.postMessage(
        { type: 'TISTORY_FN_RESPONSE', id, data: null, editorType: null, error: 'EDITOR_NOT_FOUND' },
        '*'
      );
      return;
    }

    let responseData = null;
    let error = null;

    try {
      switch (action) {
        case 'getValue':
          responseData = editor.getValue();
          break;
        case 'setValue':
          editor.setValue(value);
          responseData = true;
          break;
      }
    } catch (e) {
      error = e.message;
    }

    window.postMessage(
      { type: 'TISTORY_FN_RESPONSE', id, data: responseData, editorType: editor.type, error },
      '*'
    );
  });
})();
