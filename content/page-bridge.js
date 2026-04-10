// 티스토리 각주 변환기 - 페이지 컨텍스트 브릿지 (CodeMirror 전용)
// Content script의 isolated world에서 접근 불가한 CodeMirror 인스턴스에 접근합니다.

(function () {
  'use strict';

  function getCodeMirror() {
    // CodeMirror 5
    const cm5 = document.querySelector('.CodeMirror');
    if (cm5 && cm5.CodeMirror) {
      return {
        getValue: () => cm5.CodeMirror.getValue(),
        setValue: (v) => cm5.CodeMirror.setValue(v),
      };
    }

    // CodeMirror 6
    const cm6 = document.querySelector('.cm-editor');
    if (cm6 && cm6.cmView && cm6.cmView.view) {
      const view = cm6.cmView.view;
      return {
        getValue: () => view.state.doc.toString(),
        setValue: (v) => {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: v },
          });
        },
      };
    }

    return null;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'TISTORY_FN_REQUEST') return;

    const { id, action, value } = event.data;
    const cm = getCodeMirror();

    if (!cm) {
      window.postMessage(
        { type: 'TISTORY_FN_RESPONSE', id, data: null, error: 'CM_NOT_FOUND' },
        '*'
      );
      return;
    }

    let data = null;
    let error = null;

    try {
      if (action === 'getValue') {
        data = cm.getValue();
      } else if (action === 'setValue') {
        cm.setValue(value);
        data = true;
      }
    } catch (e) {
      error = e.message;
    }

    window.postMessage({ type: 'TISTORY_FN_RESPONSE', id, data, error }, '*');
  });
})();
