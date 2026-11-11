import { forwardRef, useImperativeHandle, useRef, type ComponentType, type Ref } from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { requireNativeView, requireOptionalNativeModule } from 'expo';

/** ref.show()：程式點一下系統「螢幕廣播」選擇器；回傳 false＝點不到，請使用者直接點這個元件 */
export type BroadcastPickerHandle = { show(): Promise<boolean> };

type NativeProps = { style?: StyleProp<ViewStyle>; ref?: Ref<BroadcastPickerHandle> };

// 只有 iOS 原生版本有這個 view（Expo Go / web / Android 為 null → 只畫空白佔位）
const NativePicker: ComponentType<NativeProps> | null =
  Platform.OS === 'ios' && requireOptionalNativeModule('LiveActivity')
    ? (requireNativeView('LiveActivity') as ComponentType<NativeProps>)
    : null;

export const isBroadcastPickerAvailable = NativePicker != null;

/**
 * 包 RPSystemBroadcastPickerView（preferredExtension = 熊貓偵測 extension）。
 * 這個 view 本身就是系統的可點按鈕；上面若要疊文字請設 pointerEvents="none"。
 */
export const BroadcastPicker = forwardRef<BroadcastPickerHandle, { style?: StyleProp<ViewStyle> }>(
  function BroadcastPicker({ style }, ref) {
    const nativeRef = useRef<BroadcastPickerHandle | null>(null);
    useImperativeHandle(ref, () => ({
      async show() {
        try {
          return (await nativeRef.current?.show()) ?? false;
        } catch {
          return false;
        }
      },
    }));
    if (!NativePicker) return <View style={style} />;
    return <NativePicker ref={nativeRef} style={style} />;
  },
);
