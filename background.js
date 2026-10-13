// 打开侧边栏：点击工具栏图标时展示 side panel
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error('setPanelBehavior failed:', e));

// 让侧边栏在 zc.tencent.com 的标签页上自动可用（Side Panel 全局开关已由行为设置覆盖）
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
