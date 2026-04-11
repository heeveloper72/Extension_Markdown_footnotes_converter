// 티스토리 각주 변환기 - 팝업 로직

(function () {
  'use strict';

  // ─── DOM 요소 ───
  var views = {
    scan: document.getElementById('view-scan'),
    loading: document.getElementById('view-loading'),
    error: document.getElementById('view-error'),
    empty: document.getElementById('view-empty'),
    confirm: document.getElementById('view-confirm'),
    done: document.getElementById('view-done'),
  };

  var els = {
    btnScan: document.getElementById('btn-scan'),
    btnRetry: document.getElementById('btn-retry'),
    btnCloseEmpty: document.getElementById('btn-close-empty'),
    btnAll: document.getElementById('btn-all'),
    btnYes: document.getElementById('btn-yes'),
    btnNo: document.getElementById('btn-no'),
    btnCloseDone: document.getElementById('btn-close-done'),
    errorText: document.getElementById('error-text'),
    emptyText: document.getElementById('empty-text'),
    progressText: document.getElementById('progress-text'),
    previewBody: document.getElementById('preview-body'),
    previewFoot: document.getElementById('preview-foot'),
    doneText: document.getElementById('done-text'),
    orphanWarning: document.getElementById('orphan-warning'),
  };

  // ─── 상태 ───
  var pairs = [];
  var currentIndex = 0;
  var convertedCount = 0;
  var skippedCount = 0;
  var currentFormat = null;

  // ─── 형식 라벨 ───
  function formatLabel(format) {
    switch (format) {
      case 'word': return 'Word';
      case 'markdown': return 'Markdown';
      case 'plaintext': return 'Plain [N]';
      case 'mixed': return 'Word+Markdown';
      default: return '';
    }
  }

  // ─── 뷰 전환 ───
  function showView(name) {
    for (var key in views) {
      views[key].classList.toggle('hidden', key !== name);
    }
  }

  // ─── 활성 탭에 메시지 전송 ───
  async function sendToContentScript(message) {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs[0];
    if (!tab) {
      throw new Error('활성 탭을 찾을 수 없습니다.');
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content.js'],
      });
    } catch (e) {
      // 이미 주입되었거나 권한 문제 - 무시
    }

    return new Promise(function (resolve, reject) {
      chrome.tabs.sendMessage(tab.id, message, function (response) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response && response.error) {
          reject(new Error(response.message || response.error));
        } else {
          resolve(response);
        }
      });
    });
  }

  // ─── 스캔 ───
  async function handleScan() {
    showView('loading');
    try {
      var result = await sendToContentScript({ action: 'scan' });

      currentFormat = result.format || null;

      if (result.alreadyProcessed) {
        if (result.format === 'rendered') {
          els.emptyText.textContent = '이미 양방향 링크가 포함된 각주입니다 (렌더링된 HTML).';
        } else {
          els.emptyText.textContent = '이미 각주가 변환된 상태입니다.';
        }
        showView('empty');
        return;
      }

      if (!result.pairs || result.pairs.length === 0) {
        var msg = '변환할 각주를 찾을 수 없습니다.';
        // 고아 정보 표시
        var warnings = [];
        if (result.orphanRefs && result.orphanRefs.length > 0) {
          warnings.push('정의 없는 참조: [^' + result.orphanRefs.join('], [^') + ']');
        }
        if (result.orphanDefs && result.orphanDefs.length > 0) {
          warnings.push('참조 없는 정의: [^' + result.orphanDefs.join('], [^') + ']');
        }
        if (warnings.length > 0) {
          msg += '\n\n' + warnings.join('\n');
        }
        els.emptyText.textContent = msg;
        showView('empty');
        return;
      }

      pairs = result.pairs;
      currentIndex = 0;
      convertedCount = 0;
      skippedCount = 0;

      // 고아 경고 표시
      if (els.orphanWarning) {
        var orphanMessages = [];
        if (result.orphanRefs && result.orphanRefs.length > 0) {
          orphanMessages.push('정의 없는 참조: [^' + result.orphanRefs.join('], [^') + ']');
        }
        if (result.orphanDefs && result.orphanDefs.length > 0) {
          orphanMessages.push('참조 없는 정의: [^' + result.orphanDefs.join('], [^') + ']');
        }
        if (orphanMessages.length > 0) {
          els.orphanWarning.textContent = orphanMessages.join(' / ');
          els.orphanWarning.classList.remove('hidden');
        } else {
          els.orphanWarning.classList.add('hidden');
        }
      }

      showCurrentPair();
    } catch (err) {
      els.errorText.textContent = err.message;
      showView('error');
    }
  }

  // ─── 현재 각주 쌍 표시 ───
  function showCurrentPair() {
    if (currentIndex >= pairs.length) {
      showDone();
      return;
    }

    var pair = pairs[currentIndex];
    var total = pairs.length;
    var remaining = total - currentIndex;

    var progressLabel = (currentIndex + 1) + '/' + total + '번째 각주';
    if (currentFormat) {
      progressLabel += ' [' + formatLabel(currentFormat) + ']';
    }
    els.progressText.textContent = progressLabel;
    els.previewBody.textContent = pair.bodyContext;
    els.previewFoot.textContent = pair.footContext;
    els.btnAll.textContent = '모두(' + remaining + '개)';

    showView('confirm');
  }

  // ─── "모두" 변환 ───
  async function handleConvertAll() {
    showView('loading');
    try {
      var result = await sendToContentScript({ action: 'convertAll' });
      if (result.success) {
        var remaining = pairs.length - currentIndex;
        convertedCount += remaining;
        currentIndex = pairs.length;
        showDone();
      }
    } catch (err) {
      els.errorText.textContent = err.message;
      showView('error');
    }
  }

  // ─── "네" - 현재 각주 변환 ───
  async function handleConvertOne() {
    var pair = pairs[currentIndex];
    showView('loading');
    try {
      var result = await sendToContentScript({
        action: 'convertOne',
        number: pair.number,
      });
      if (result.success) {
        convertedCount++;
        currentIndex++;
        showCurrentPair();
      }
    } catch (err) {
      els.errorText.textContent = err.message;
      showView('error');
    }
  }

  // ─── "아니요" - 건너뛰기 ───
  function handleSkip() {
    skippedCount++;
    currentIndex++;
    showCurrentPair();
  }

  // ─── 완료 화면 ───
  function showDone() {
    var parts = [];
    if (convertedCount > 0) {
      parts.push(convertedCount + '개 변환 완료');
    }
    if (skippedCount > 0) {
      parts.push(skippedCount + '개 건너뜀');
    }
    els.doneText.textContent = parts.length > 0 ? parts.join(', ') : '처리 완료';
    showView('done');
  }

  // ─── 이벤트 바인딩 ───
  els.btnScan.addEventListener('click', handleScan);
  els.btnRetry.addEventListener('click', handleScan);
  els.btnCloseEmpty.addEventListener('click', function () { window.close(); });
  els.btnAll.addEventListener('click', handleConvertAll);
  els.btnYes.addEventListener('click', handleConvertOne);
  els.btnNo.addEventListener('click', handleSkip);
  els.btnCloseDone.addEventListener('click', function () { window.close(); });
})();
