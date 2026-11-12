// v1.0 偵測到邀請 → 動態島/鎖定畫面立即顯示（純函式；Swift 的測試替身）。
// ⚠️ 規則與文字＝modules/live-activity/ios/DetectorHub.swift（showOffer/hideOffer/offerFare/offerAlert*）、
//    targets/widget/PandaLiveActivity.swift（OfferDetail/OfferBadge/offerSubtitle）、
//    targets/broadcast/SampleHandler.swift（PandaSignal.clearedReason）；test/offerIsland.test.mjs 比對原始碼字串。
import { exactFare } from './orders.ts';
import type { OfferClearReason } from './detector.ts';

/** 「已偵測邀請」最多顯示幾秒（沒收到 cleared/order 也回待命；staleDate＝偵測＋這麼多秒） */
export const OFFER_ISLAND_SECONDS = 60;

/** 遠端設定 offer 區塊的 App 端欄位（OfferTracker 不讀） */
export type AlertSound = 'default' | 'none';
export type OfferIslandSettings = { islandIndicator: boolean; alertSound: AlertSound };
export const DEFAULT_OFFER_ISLAND: Readonly<OfferIslandSettings> = Object.freeze({ islandIndicator: true, alertSound: 'default' });
export const ALERT_SOUNDS: readonly AlertSound[] = ['default', 'none'];

/** 卡片金額＝平台確切報酬（同 src/orders.ts exactFare；Swift 用整數分 minutes*24500/60+1） */
export function offerFare(minutes: number): number {
  return exactFare(minutes);
}

export type OfferTexts = {
  compact: string;
  minimal: string;
  title: string;
  subtitle: string;
  badge: string;
  alertTitle: string;
  alertBody: string;
  alertBodyCounting: string;
};

/** 動態島/鎖定畫面/提示的文字（amount null → 只寫「可以按接受」） */
export function offerTexts(minutes: number, amount: number | null): OfferTexts {
  const subtitle = (amount != null ? `$${amount.toFixed(2)}・` : '') + '可以按接受';
  return {
    compact: `${minutes}分✓`,
    minimal: `${minutes}`,
    title: `✓ 已偵測 ${minutes} 分邀請`,
    subtitle,
    badge: `＋偵測到 ${minutes} 分邀請・${subtitle}`,
    alertTitle: `已偵測 ${minutes} 分邀請`,
    alertBody: '可以按接受訂單',
    alertBodyCounting: '可以按接受訂單・倒數照常進行',
  };
}

/**
 * 收到 offer.pending 時卡片怎麼變：倒數中（mode "countdown"）→ 'badge'（不蓋倒數，只加一行）；
 * 其他（standby/offer/stopped）→ 'offer'（整張卡變「已偵測邀請」）；islandIndicator=false → 'none'
 */
export function offerCardAction(mode: string | null | undefined, s: OfferIslandSettings = DEFAULT_OFFER_ISLAND): 'none' | 'badge' | 'offer' {
  if (!s.islandIndicator) return 'none';
  return mode === 'countdown' ? 'badge' : 'offer';
}

/** 收到 cleared 後卡片回到什麼模式：'offer' → standby；其他不變（倒數只清邀請行） */
export function modeAfterClear(mode: string | null | undefined): string | null | undefined {
  return mode === 'offer' ? 'standby' : mode;
}

/** 偵測後超過 60 秒 → 過期（widget isStale 畫回偵測中；App 端 asyncAfter 清掉） */
export function offerExpired(offerAt: number, now: number): boolean {
  return now - offerAt >= OFFER_ISLAND_SECONDS * 1000;
}

/**
 * extension：OfferTracker 判定原因 → cleared 原因（＝PandaSignal.clearedReason）。
 * rejected（命中拒單詞）/replaced（邀請直接換成另一張）＝reject；stopped＝stopped；其他（timeout/superseded）＝timeout
 */
export function clearedReasonFor(trackerReason: string): OfferClearReason {
  if (trackerReason === 'rejected' || trackerReason === 'replaced') return 'reject';
  if (trackerReason === 'stopped') return 'stopped';
  return 'timeout';
}
