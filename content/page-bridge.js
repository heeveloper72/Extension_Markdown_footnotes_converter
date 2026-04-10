// 티스토리 각주 변환기 - 페이지 컨텍스트 브릿지
// Content script의 isolated world에서 접근 불가한 에디터 인스턴스에 접근합니다.
// 우선순위: Tistory CM5 → Tistory TinyMCE → 범용 CM5 → 범용 CM6

(function () {
  'use strict';

  function getEditor() {
    // 1. Tistory HTML 모드: .cm-s-tistory-html (CodeMirror 5)
    const tCm = document.querySelector('.cm-s-tistory-html');
    if (tCm && tCm.CodeMirror) {
      return {
        type: 'tistory-cm5',
        getValue: () => tCm.CodeMirror.getValue(),
        setValue: (v) => {
          // replaceRange로 변경해야 에디터가 dirty 상태를 인식함
          // (setValue는 히스토리 초기화 + markClean 호출로 변경 감지 안 됨)
          const cm = tCm.CodeMirror;
          cm.operation(() => {
            const last = cm.lastLine();
            cm.replaceRange(v, {line: 0, ch: 0}, {line: last, ch: cm.getLine(last).length});
          });
        },
      };
    }

    // 2. Tistory 비주얼 모드: TinyMCE
    if (typeof tinymce !== 'undefined') {
      const tinyEditor = tinymce.get('editor-tistory');
      if (tinyEditor) {
        return {
          type: 'tistory-tinymce',
          getValue: () => tinyEditor.getContent(),
          setValue: (v) => tinyEditor.setContent(v),
        };
      }
    }

    // 3. 범용 CodeMirror 5 폴백
    const cm5 = document.querySelector('.CodeMirror');
    if (cm5 && cm5.CodeMirror) {
      return {
        type: 'cm5',
        getValue: () => cm5.CodeMirror.getValue(),
        setValue: (v) => {
          const cm = cm5.CodeMirror;
          cm.operation(() => {
            const last = cm.lastLine();
            cm.replaceRange(v, {line: 0, ch: 0}, {line: last, ch: cm.getLine(last).length});
          });
        },
      };
    }

    // 4. 범용 CodeMirror 6 폴백
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

    let data = null;
    let error = null;

    try {
      if (action === 'getValue') {
        data = editor.getValue();
      } else if (action === 'setValue') {
        editor.setValue(value);
        data = true;
      }
    } catch (e) {
      error = e.message;
    }

    window.postMessage({ type: 'TISTORY_FN_RESPONSE', id, data, editorType: editor.type, error }, '*');
  });
})();
