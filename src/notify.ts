import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// 只用「本地通知」：不註冊推播、不需要 aps-environment entitlement。
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let permissionAsked = false;

export async function ensurePermission(): Promise<boolean> {
  try {
    const cur = await Notifications.getPermissionsAsync();
    if (cur.granted) return true;
    if (permissionAsked && !cur.canAskAgain) return false;
    permissionAsked = true;
    const res = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    return res.granted;
  } catch {
    return false;
  }
}

async function scheduleAt(when: number, title: string, body: string): Promise<string | null> {
  if (when <= Date.now() + 1000) return null;
  return Notifications.scheduleNotificationAsync({
    content: { title, body, sound: 'default' }, // 不用 timeSensitive：那需要額外 entitlement
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(when) },
  });
}

/** 截止前 3 分鐘與截止時各一則 */
export async function scheduleReminders(deadline: number, estimateMin: number): Promise<string[]> {
  if (Platform.OS === 'web') return [];
  try {
    if (!(await ensurePermission())) return [];
    const ids = await Promise.all([
      scheduleAt(deadline - 3 * 60_000, '🐼 剩 3 分鐘', `預估 ${estimateMin} 分的單快到了，加油！`),
      scheduleAt(deadline, '🐼 已到預估時間', `預估 ${estimateMin} 分的單已到時，現在開始算超時`),
    ]);
    return ids.filter((x): x is string => !!x);
  } catch {
    return [];
  }
}

export async function cancelReminders(ids: string[] | undefined): Promise<void> {
  if (!ids?.length) return;
  await Promise.all(
    ids.map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined)),
  );
}
