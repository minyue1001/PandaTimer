// v0.6 多單：同一張「偵測卡」掛多張自動單時，卡上顯示什麼（純函式，無 import）。
// ⚠️ 與 DetectorCardPlan.swift（modules/live-activity/ios、native/intents、targets/widget 三份逐字相同）同規則；
//    Swift 在 WSL 不能跑，這份是測試替身。改一邊改兩邊。
//  - 倒數顯示**最早截止**那單（同截止依接單時間）
//  - 其餘寫進 ContentState.others：「另 2 單：18:42、18:55 截止」；超過 3 單 →「另 5 單：18:42、18:55、19:01… 截止」
//  - 送達/取消一單後：卡上還有單 → 切到下一單；沒有 → 偵測卡回待命（一般卡結束）

export type PlanItem = { id: string; acceptedAt: number; estimateMin: number; deadline: number; activityId?: string };

export const MAX_LISTED = 3;

export function sortByDeadline<T extends PlanItem>(items: readonly T[]): T[] {
  return items.slice().sort((a, b) => (a.deadline !== b.deadline ? a.deadline - b.deadline : a.acceptedAt - b.acceptedAt));
}

/** HH:mm（本地時間，24 小時制） */
export function clockHm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function othersText(rest: readonly PlanItem[]): string | null {
  if (!rest.length) return null;
  const times = rest.slice(0, MAX_LISTED).map((o) => clockHm(o.deadline)).join('、');
  const more = rest.length > MAX_LISTED ? '…' : '';
  return `另 ${rest.length} 單：${times}${more} 截止`;
}

/** 進行中鏡像 → 這張卡要顯示的主單與 others；沒有單 → main = null（回待命/結束） */
export function planCard(mirror: readonly PlanItem[], cardId: string): { main: PlanItem | null; others: string | null; count: number } {
  const mine = sortByDeadline(mirror.filter((o) => o.activityId === cardId));
  return { main: mine[0] ?? null, others: othersText(mine.slice(1)), count: mine.length };
}
