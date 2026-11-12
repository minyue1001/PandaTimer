// 有副作用的確認流程（Alert＋controller），首頁與紀錄頁共用；文字沿用改版前
import { Alert } from 'react-native';
import { cancelOrder, previewPrune, pruneOrders } from '../controller';
import type { Order } from '../orders';
import { describePlan, formatTaipeiDateTime, type PruneCriteria } from '../prune';

export type Toast = (msg: string) => void;

export function runPrune(c: PruneCriteria, toast: Toast) {
  void pruneOrders(c).then((p) => toast(`已刪除 ${p.count} 筆紀錄${p.activeCount ? `（含進行中 ${p.activeCount} 筆）` : ''}`));
}

/** 批次刪除前預覽；extra＝「下一步」（刪除全部要再輸入「刪除」） */
export async function confirmPrune(title: string, c: PruneCriteria, toast: Toast, extra?: () => void) {
  const plan = await previewPrune(c);
  if (!plan.count) {
    Alert.alert(title, '沒有符合的紀錄');
    return;
  }
  Alert.alert(title, describePlan(plan), [
    { text: '不要', style: 'cancel' },
    extra
      ? { text: '下一步', style: 'destructive', onPress: extra }
      : { text: `刪除 ${plan.count} 筆`, style: 'destructive', onPress: () => runPrune(c, toast) },
  ]);
}

/** 單筆刪除（進行中卡片/紀錄列長按） */
export function confirmDeleteOne(o: Order, toast: Toast) {
  const detail = `接單 ${formatTaipeiDateTime(o.acceptedAt)}\n預估 ${o.estimateMin} 分・${
    o.status === 'active' ? '進行中（會關閉動態島、取消提醒）' : o.status === 'canceled' ? '已取消' : `實際 ${o.actualMin} 分`
  }\n刪除後無法復原。`;
  Alert.alert('刪除這筆紀錄？', detail, [
    { text: '不要', style: 'cancel' },
    { text: '刪除', style: 'destructive', onPress: () => runPrune({ kind: 'ids', ids: [o.id] }, toast) },
  ]);
}

export function confirmCancel(id: string) {
  Alert.alert('取消這張單？', '不會算進統計', [
    { text: '不要', style: 'cancel' },
    { text: '取消這單', style: 'destructive', onPress: () => void cancelOrder(id) },
  ]);
}
