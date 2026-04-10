// 티스토리 각주 변환기 - 팝업 로직

(function () {
  'use strict';

  // ─── DOM 요소 ───
  const views = {
    scan: document.getElementById('view-scan'),
    loading: document.getElementById('view-loading'),
    error: document.getElementById('view-error'),
    empty: document.getElementById('view-empty'),
    confirm: document.getElementById('view-confirm'),
    done: document.getElementById('view-done'),
  };

  const els = {
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
  };

  // ─── 상태 ───
  let pairs = [];
  let currentIndex = 0;
  let convertedCount = 0;
  let skippedCount = 0;

  // ─── 뷰 전환 ───
  function showView(name) {
    for (const key of Object.keys(views)) {
      views[key].classList.toggle('hidden', key !== name);
    }
  }

  // ─── 활성 탭에 메시지 전송 ───
  async function sendToContentScript(message) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      throw new Error('활성 탭을 찾을 수 없습니다.');
    }

    // 콘텐츠 스크립트가 아직 주입되지 않은 경우 주입 시도
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content.js'],
      });
    } catch (e) {
      // 이미 주입되었거나 권한 문제 - 무시하고 메시지 전송 시도
    }

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, message, (response) => {
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
      const result = await sendToContentScript({ action: 'scan' });

      if (result.alreadyProcessed) {
        els.emptyText.textContent = '이미 각주가 변환된 상태입니다.';
        showView('empty');
        return;
      }

      if (!result.pairs || result.pairs.length === 0) {
        els.emptyText.textContent = '변환할 각주를 찾을 수 없습니다.';
        showView('empty');
        return;
      }

      pairs = result.pairs;
      currentIndex = 0;
      convertedCount = 0;
      skippedCount = 0;

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

    const pair = pairs[currentIndex];
    const total = pairs.length;
    const remaining = total - currentIndex;

    els.progressText.textContent = `${currentIndex + 1}/${total}번째 각주`;
    els.previewBody.textContent = pair.bodyContext;
    els.previewFoot.textContent = pair.footContext;
    els.btnAll.textContent = `모두(${remaining}개)`;

    showView('confirm');
  }

  // ─── "모두" 변환 ───
  async function handleConvertAll() {
    showView('loading');
    try {
      const result = await sendToContentScript({ action: 'convertAll' });
      if (result.success) {
        const remaining = pairs.length - currentIndex;
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
    const pair = pairs[currentIndex];
    showView('loading');
    try {
      const result = await sendToContentScript({
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
    const parts = [];
    if (convertedCount > 0) {
      parts.push(`${convertedCount}개 변환 완료`);
    }
    if (skippedCount > 0) {
      parts.push(`${skippedCount}개 건너뜀`);
    }
    els.doneText.textContent = parts.length > 0 ? parts.join(', ') : '처리 완료';
    showView('done');
  }

  // ─── 이벤트 바인딩 ───
  els.btnScan.addEventListener('click', handleScan);
  els.btnRetry.addEventListener('click', handleScan);
  els.btnCloseEmpty.addEventListener('click', () => window.close());
  els.btnAll.addEventListener('click', handleConvertAll);
  els.btnYes.addEventListener('click', handleConvertOne);
  els.btnNo.addEventListener('click', handleSkip);
  els.btnCloseDone.addEventListener('click', () => window.close());
})();
