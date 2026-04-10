// 티스토리 각주 변환기 - 서비스 워커
// Manifest V3에서 popup은 chrome.tabs.sendMessage로 content script와 직접 통신하므로,
// background는 최소한으로 유지합니다.

chrome.runtime.onInstalled.addListener(() => {
  console.log('티스토리 각주 변환기가 설치되었습니다.');
});
