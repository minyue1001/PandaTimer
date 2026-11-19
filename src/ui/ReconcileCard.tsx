// 紀錄頁「今日對帳」：輸入平台的當日單數/金額/小費 → 伺服器比對 telemetry 找漏記/記錯 → 勾選、可改欄位 → 套用到本機紀錄（再同步）
import { useState } from 'react';
import { Alert, Pressable, Text, TextInput, View, type KeyboardTypeOptions } from 'react-native';
import { applyReconcile } from '../controller';
import {
  buildOps,
  diffText,
  initialEdit,
  parseMoney,
  taipeiDate,
  type Proposal,
  type ProposalEdit,
  type ReconcileResult,
} from '../reconcile';
import { requestReconcile, syncNow } from '../syncClient';
import type { Toast } from './actions';
import { Btn, Collapsible } from './common';
import { C, F, pressed, S } from './theme';

const TYPE_LABEL: Record<Proposal['type'], string> = { add: '補登', restore: '還原', tip: '小費', review: '檢查' };
const ACTION_LABEL = { delete: '刪除這筆', cancel: '改成取消', edit: '改分鐘/金額' } as const;

export function ReconcileCard({ toast }: { toast: Toast }) {
  const [dayOffset, setDayOffset] = useState<0 | -1>(0);
  const [count, setCount] = useState('');
  const [amount, setAmount] = useState('');
  const [tips, setTips] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [res, setRes] = useState<ReconcileResult | null>(null);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, ProposalEdit>>({});

  const date = taipeiDate(Date.now(), dayOffset);
  const onRun = async () => {
    const n = Number(count.trim());
    const a = parseMoney(amount);
    const t = parseMoney(tips);
    if (!/^\d{1,3}$/.test(count.trim()) || !Number.isFinite(n)) return Alert.alert('單數格式不對', '請輸入平台顯示的完成單數（整數）');
    if (a == null || !Number.isFinite(a)) return Alert.alert('金額格式不對', '請輸入平台當日總金額（含小費，不含補錢），例如 1184.35');
    if (t != null && !Number.isFinite(t)) return Alert.alert('小費格式不對', '小費總額可不填；要填就輸入數字');
    setBusy(true);
    setMsg('同步並比對中…');
    setRes(null);
    try {
      const r = await requestReconcile({ date, count: n, amount: a, tips: t });
      if (!r.ok) {
        setMsg(`❌ ${r.message}`);
        return;
      }
      setMsg(r.syncMessage);
      setRes(r.result);
      setSel(Object.fromEntries(r.result.proposals.map((p) => [p.id, p.confidence === 'high'])));
      setEdits(Object.fromEntries(r.result.proposals.map((p) => [p.id, initialEdit(p)])));
    } finally {
      setBusy(false);
    }
  };

  const onApply = () => {
    if (!res) return;
    const chosen = res.proposals.filter((p) => sel[p.id]);
    const { ops, errors } = buildOps(res.date, chosen, edits);
    if (errors.length) return Alert.alert('還不能套用', errors.join('\n'));
    if (!ops.length) return Alert.alert('沒有可套用的項目', '請勾選要套用的提議（純提醒的項目不能套用）');
    Alert.alert('套用對帳結果', `要套用 ${ops.length} 項到紀錄嗎？（會同步到雲端；套用後可在紀錄頁長按刪除）`, [
      { text: '不要', style: 'cancel' },
      {
        text: '套用',
        onPress: () =>
          void applyReconcile(ops).then((r) => {
            toast(`已套用 ${r.done} 項${r.skipped ? `，${r.skipped} 項找不到那張單（請先同步）` : ''}`);
            setRes(null);
            setMsg('已套用；可以再按「比對」確認差額歸零');
            void syncNow();
          }),
      },
    ]);
  };

  const setEdit = (id: string, patch: ProposalEdit) => setEdits((e) => ({ ...e, [id]: { ...e[id], ...patch } }));

  return (
    <Collapsible title="🧾 今日對帳">
      <Text style={S.small}>
        輸入 foodpanda 平台上的完成單數、總金額（各單報酬＋小費，不含補錢）、小費總額（選填）。伺服器用偵測紀錄找出漏記/記錯的單，勾選後套用。需要先配對雲端同步。
      </Text>
      <View style={S.row}>
        <Btn style={{ flex: 1 }} small kind={dayOffset === 0 ? 'pink' : 'ghost'} title={`今天 ${taipeiDate(Date.now(), 0).slice(5)}`} onPress={() => setDayOffset(0)} />
        <Btn style={{ flex: 1 }} small kind={dayOffset === -1 ? 'pink' : 'ghost'} title={`昨天 ${taipeiDate(Date.now(), -1).slice(5)}`} onPress={() => setDayOffset(-1)} />
      </View>
      <Field label="完成單數" value={count} onChange={setCount} placeholder="例如 14" keyboard="number-pad" />
      <Field label="總金額" value={amount} onChange={setAmount} placeholder="例如 1184.35" keyboard="decimal-pad" />
      <Field label="小費總額" value={tips} onChange={setTips} placeholder="選填" keyboard="decimal-pad" />
      <Btn title={busy ? '比對中…' : '比對'} disabled={busy} onPress={() => void onRun()} />
      {!!msg && <Text style={S.small}>{msg}</Text>}
      {res && (
        <View style={{ gap: 12 }}>
          <Text style={S.textBold}>{diffText(res)}</Text>
          {res.info.map((t) => (
            <Text key={t} style={S.small}>
              ・{t}
            </Text>
          ))}
          {res.proposals.length === 0 ? (
            <Text style={[S.text, { color: res.diff.count === 0 && res.diff.amount === 0 ? C.green : C.orange }]}>
              {res.diff.count === 0 && res.diff.amount === 0 ? '✅ 跟平台一致' : '找不到可自動補的證據，請對照平台明細手動修改'}
            </Text>
          ) : (
            res.proposals.map((p) => (
              <ProposalRow
                key={p.id}
                p={p}
                checked={!!sel[p.id]}
                onToggle={() => setSel((s) => ({ ...s, [p.id]: !s[p.id] }))}
                edit={edits[p.id] ?? {}}
                setEdit={(patch) => setEdit(p.id, patch)}
              />
            ))
          )}
          {res.proposals.length > 0 && <Btn kind="green" title="套用勾選的項目" onPress={onApply} />}
        </View>
      )}
    </Collapsible>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  keyboard,
}: {
  label: string;
  value: string;
  onChange: (t: string) => void;
  placeholder?: string;
  keyboard?: KeyboardTypeOptions;
}) {
  return (
    <View style={[S.row, { flex: 1 }]}>
      <Text style={[S.small, { width: 72, color: C.sub }]}>{label}</Text>
      <TextInput
        style={[S.input, { flex: 1, fontSize: F.body }]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={C.dim}
        keyboardType={keyboard}
        keyboardAppearance="dark"
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

function ProposalRow({
  p,
  checked,
  onToggle,
  edit,
  setEdit,
}: {
  p: Proposal;
  checked: boolean;
  onToggle: () => void;
  edit: ProposalEdit;
  setEdit: (patch: ProposalEdit) => void;
}) {
  const clock = 'numbers-and-punctuation' as const;
  const needs = (k: string) => p.needs.includes(k);
  const action = edit.action ?? p.actions?.[0];
  return (
    <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: C.border, paddingTop: 10 }}>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={onToggle} style={(st) => [S.row, { alignItems: 'flex-start', minHeight: 48 }, pressed(st)]}>
        <Text style={{ fontSize: 26, color: checked ? C.green : C.dim, width: 32 }}>{checked ? '☑' : '☐'}</Text>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[S.small, { color: p.confidence === 'high' ? C.green : C.orange, fontWeight: '800' }]}>
            {TYPE_LABEL[p.type]}・{p.confidence === 'high' ? '把握高' : '請確認'}
            {p.needs.length ? '・有欄位待填' : ''}
          </Text>
          <Text style={[S.text, { fontSize: 17, lineHeight: 24 }]}>{p.text}</Text>
        </View>
      </Pressable>
      {checked && p.type === 'add' && (
        <View style={{ gap: 8 }}>
          {p.options && p.options.length > 0 && (
            <View style={S.wrap}>
              {p.options.map((o, i) => (
                <Btn
                  key={o.label}
                  small
                  kind={edit.option === i ? 'pink' : 'ghost'}
                  title={o.label}
                  onPress={() =>
                    setEdit({
                      option: i,
                      minutes: o.fields.estimateMin != null ? String(o.fields.estimateMin) : '',
                      amount: o.fields.amount != null ? String(o.fields.amount) : '',
                      tip: o.fields.tip != null ? String(o.fields.tip) : '',
                    })
                  }
                />
              ))}
            </View>
          )}
          <View style={S.row}>
            <Field label={needs('acceptedAt') ? '接單 *' : '接單'} value={edit.accepted ?? ''} onChange={(t) => setEdit({ accepted: t })} placeholder="HH:mm" keyboard={clock} />
          </View>
          <View style={S.row}>
            <Field label={needs('deliveredAt') ? '送達 *' : '送達'} value={edit.delivered ?? ''} onChange={(t) => setEdit({ delivered: t })} placeholder="HH:mm" keyboard={clock} />
          </View>
          <View style={S.row}>
            <Field label={needs('estimateMin') ? '分鐘 *' : '分鐘'} value={edit.minutes ?? ''} onChange={(t) => setEdit({ minutes: t })} placeholder="預估分" keyboard="number-pad" />
            <Field label={needs('amount') ? '金額 *' : '金額'} value={edit.amount ?? ''} onChange={(t) => setEdit({ amount: t })} placeholder="$" keyboard="decimal-pad" />
          </View>
          <View style={S.row}>
            <Field label="小費" value={edit.tip ?? ''} onChange={(t) => setEdit({ tip: t })} placeholder="沒有就空白" keyboard="decimal-pad" />
          </View>
        </View>
      )}
      {checked && p.type === 'restore' && (
        <Field label="送達" value={edit.delivered ?? ''} onChange={(t) => setEdit({ delivered: t })} placeholder="HH:mm" keyboard={clock} />
      )}
      {checked && p.type === 'tip' && p.orderId && (
        <Field label="小費" value={edit.tip ?? ''} onChange={(t) => setEdit({ tip: t })} placeholder="$" keyboard="decimal-pad" />
      )}
      {checked && p.type === 'review' && p.actions && p.actions.length > 0 && (
        <View style={{ gap: 8 }}>
          <View style={S.wrap}>
            {p.actions.map((a) => (
              <Btn key={a} small kind={action === a ? (a === 'delete' ? 'danger' : 'pink') : 'ghost'} title={ACTION_LABEL[a]} onPress={() => setEdit({ action: a })} />
            ))}
          </View>
          {action === 'edit' && (
            <View style={S.row}>
              <Field label="分鐘" value={edit.minutes ?? ''} onChange={(t) => setEdit({ minutes: t })} keyboard="number-pad" />
              <Field label="金額" value={edit.amount ?? ''} onChange={(t) => setEdit({ amount: t })} keyboard="decimal-pad" />
            </View>
          )}
        </View>
      )}
    </View>
  );
}
