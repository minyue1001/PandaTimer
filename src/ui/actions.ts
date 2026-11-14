// 有副作用的確認流程（Alert＋controller），首頁與紀錄頁共用；文字沿用改版前
import { Alert } from 'react-native';
import { cancelOrder, previewPrune, pruneOrders, setOrderTip, startOrder } from '../controller';
import { MAX_TIP, parseTipInput, type Order } from '../orders';
import { money } from '../earnings';
import { describePlan, formatTaipeiDateTime, type PruneCriteria } from '../prune';
import { parseMinutesInput, type ScreenHint } from '../unconfirmedOffers';

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

/** v1.2 小費輸入（iOS 文字輸入對話框；存檔即寫入本機並排雲端同步）。空白或 0＝清除小費 */
export function promptTip(o: Order, toast: Toast, onDone?: () => void) {
  const cur = o.tip != null ? String(o.tip) : '';
  Alert.prompt(
    '小費',
    `${o.tip != null ? `目前 ${money(o.tip)}。` : ''}輸入這單的小費金額（元，0~${MAX_TIP}；留空＝沒有）`,
    [
      { text: '取消', style: 'cancel', onPress: () => onDone?.() },
      {
        text: '儲存',
        onPress: (text?: string) => {
          onDone?.();
          const r = parseTipInput(text);
          if (!r.ok) {
            Alert.alert('金額格式不對', `請輸入 0~${MAX_TIP} 的數字，最多兩位小數`);
            return;
          }
          void setOrderTip(o.id, r.tip).then(() => toast(r.tip != null ? `已記小費 ${money(r.tip)}` : '已清除小費'));
        },
      },
    ],
    'plain-text',
    cur,
    'decimal-pad',
  );
}

/** v1.2 送單畫面 N 筆訂單、App 少記 → 補記一張（輸入預估分鐘；接單時間＝畫面看到的時間，source 'confirm'） */
export function promptMissingOrder(h: ScreenHint, toast: Toast) {
  Alert.prompt(
    '補記一張單',
    `畫面顯示 ${h.n} 筆訂單，App 只有 ${h.active} 張。輸入漏掉那張的預估分鐘（1~90）`,
    [
      { text: '取消', style: 'cancel' },
      {
        text: '補記',
        onPress: (text?: string) => {
          const min = parseMinutesInput(text);
          if (min == null) {
            Alert.alert('分鐘數不對', '請輸入 1~90 的整數');
            return;
          }
          void startOrder(min, toast, { acceptedAt: h.at, source: 'confirm' }).then(() => toast(`已補記：預估 ${min} 分`));
        },
      },
    ],
    'plain-text',
    '',
    'number-pad',
  );
}

export function confirmCancel(id: string) {
  Alert.alert('取消這張單？', '不會算進統計', [
    { text: '不要', style: 'cancel' },
    { text: '取消這單', style: 'destructive', onPress: () => void cancelOrder(id) },
  ]);
}
