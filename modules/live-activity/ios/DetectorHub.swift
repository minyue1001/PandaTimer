import ActivityKit
import AVFoundation
import CoreLocation
import Foundation
import UIKit
import UserNotifications

// v0.4/v0.5/v0.6：螢幕廣播 extension（PandaBroadcast）→ App 的訊號中樞。
// 實測（v0.3）：ActivityKit 在 broadcast extension 內完全不可用 → extension 只負責 OCR，
// 用 Darwin notification（跨程序、不需 App Group/entitlement）以「名稱」編碼資料通知 App：
//   com.pandatimer.order.<N>.<S>（N=1…90 分、S=序號 0…3）、com.pandatimer.broadcast.started/.stopped/.heartbeat、
//   com.pandatimer.drain（App Intents 寫了事件佇列 → 請 JS drain）。
// ⚠️ 名稱與 targets/broadcast/SampleHandler.swift 的 PandaSignal、src/detector.ts 的 parseSignalName 必須一致。
// App 端要活著才收得到 → 偵測期間保活，見 KeepAlive。
// v0.4 實測（iOS 26.6.2）：只靠靜音音訊保活時，背景的 Activity.update 全部無聲失效。
// v0.5：保活改用背景定位（音訊只當備援）。v0.5 實測：update 有生效，但動態島畫面要關螢幕再打開才重繪；
//   同一張 27 分的圖只偵測得到第一單（extension 與 App 兩層「同分鐘數」去重＋同名 Darwin 通知合併）。
// v0.6：
//   - App 不再去重：每收到一則 order 訊號＝一張新單（extension 負責邊緣觸發＋（分鐘, 金額）90 秒去重；序號跳號＝訊號遺失）。
//   - 多單共用偵測卡：每張自動單都掛在偵測卡上（鏡像 activityId＝偵測卡 id），卡片顯示最早截止那單、others 列其餘
//     （DetectorCardPlan.swift，三份逐字相同）；送達一單自動切到下一單。
//   - 新單用 update(_:alertConfiguration:) 強制展開提示＋重繪；心跳 update 不帶 alert。
//   - 遠端狀態回報（PandaTelemetry，source "app"）。
//   一鍵備援照舊：① 點「偵測到新單」通知 → App 進前景 → 依鏡像重推卡片；② 偵測卡上的「開始倒數」按鈕。
// v0.7 接單後才開始倒數：extension 看到邀請只送 com.pandatimer.offer.pending.<分>（App 顯示「等你接單」）、
//   判定未接送 com.pandatimer.offer.cleared；判定接單先送 com.pandatimer.accept.delay.<0…60>（按下接受到現在幾秒）
//   再送 order 訊號 → App 在 2 秒內配對，acceptedAt＝收到 order 的時間 − 延遲（配不到就用收到時間；
//   App 曾被暫停則照舊用通知 userInfo 的 detectedAt，v0.7 起它就是按下接受的時間）。
//   v0.7 自動送達：extension 看到完成/送達畫面送 com.pandatimer.delivered → AutoDelivery 結「接單超過
//   delivery.minOrderAgeSec 的進行中單」裡最早那張（實際時間＝收到時間），走與送達按鈕相同的鏡像/事件/卡片路徑。
//   手動/自動互斥：90 秒內有手動結單 → 不自動結；自動結單後 20 秒內的送達按鈕/捷徑 → 不再結（PandaSharedStore）。
//   註冊：4 狀態＋360 order＋90 pending＋1 cleared＋61 delay＋1 delivered＝517 個（< 1000）。
// v0.8：
//   - com.pandatimer.offer.stacked（夾單；在 accept.delay 之前送）→ 2 秒內配對到的 order 記 stacked:true。
//   - com.pandatimer.delivered.delay.<0…60>（在 delivered 之前送）→ 實際送達＝收到 − 秒數；AutoDelivery 改結「截止最早」的單。
//   - 鎖屏/解鎖（protectedData 通知）回報 lock/unlock；偵測中（使用者沒按停止偵測）卻收到 stopped →
//     通知「偵測停止了，點我重新開始」（userInfo pandatimer=redetect，JS 點了自動叫出廣播視窗；60 秒內不重複）＋偵測卡顯示。
//   註冊：517＋1＋61＝579 個（< 1000）。
// v0.9 省電：
//   - 心跳的偵測卡 update 只在診斷字有實質變化（去掉心跳時間後不同、模式要變）或距上次 update 滿 app.cardRefreshSeconds（300）
//     才做（pushCard throttle；其他事件照舊立即 update）。倒數用 Text(style: .timer) 由系統畫，不需要每秒 update。
//   - beat/arm/disarm/sig 帶 batt/charging/thermal/lowPower（DevicePower；UIDevice 只在主執行緒讀，快取）。
//   - 低電量模式或過熱（power 設定，同 extension 規則）→ 偵測卡診斷字加「省電中」。
//   - 定位保活精度/距離過濾走遠端設定 keepAlive（預設 hundred/50＝v0.5~0.8 行為）。
// v1.0 偵測當下就看得到（使用者回饋：動態島看不出偵測成功，要回 App 看到「等待」才敢按接受）：
//   - offer.pending.<分> → 偵測卡立即 update 成 mode "offer"（✓ 已偵測 N 分邀請・$金額・可以按接受）＋alertConfiguration
//     （強制展開＋重繪；聲音 offer.alertSound）；卡片正在倒數其他單 → 不蓋倒數，只寫 offerMin/offerAmount/offerAt
//     （widget 在倒數下方顯示「＋偵測到 N 分邀請」）＋同樣的 alert。offer.islandIndicator=false → 不動卡片。
//   - offer.cleared.<reject|timeout|stopped> → 卡片回 standby（倒數中只清掉邀請行）；order → 照舊轉倒數（apply 清邀請欄位）；
//     60 秒沒結果也自動清（staleDate＝偵測＋60 秒，widget isStale 時畫回偵測中）。JS 事件 offerCleared 帶 reason/minutes。
//   - 偵測卡的 update 一律走 enqueueCard 串行（邀請顯示/清除、心跳、停止不會亂序）。
//   - extension 心跳後送 ext.mode.<away|normal>、ext.mem.<MB>、ext.peak.<MB>（0…80）→ statusJSON 帶 extMode/memMB/peakMB/extAt，
//     加上 App 自己的 lowPower/thermal/saver/batt/charging（首頁膠囊「省電中」、設定頁診斷）。
//   註冊：579＋3（cleared 原因）＋2＋81＋81＝746 個（< 1000）。
// v1.1 以單號配對送達（extension 規則見 targets/broadcast/OrderNumbers.swift；App 規則＝src/detector.ts slotsAfterOrder/slotTarget、
//   src/deliveryDetector.ts pickDeliveredOrder(matchedId)）：
//   - 收到 order.<分>.<槽> → 記「槽 → 訂單 id」（seqOrders，UserDefaults 保存；漏掉的槽清掉；started 全清）。
//   - com.pandatimer.delivered.seq.<槽>（在 delivered.delay 之後）→ 只結那張（不看 minOrderAge/手動互斥）；那張已不在進行中 →
//     不結（matchedGone，不退回挑別張）；槽沒有對應 → 退回截止最早。telemetry delivered 帶 matched。
//   - 疊單：接單時鏡像裡已有進行中單 → stacked＋stackKind "carry"（夾單字樣＝"offer"）。
//   - 邀請動態島回讀：update 後**同一個 Activity 物件的 content 不會立刻變**（v1.0 一律 ✗ state:active 的原因；order 的 verifyCard
//     是 1 秒後重新查才 ✓）→ 改成 0.25 秒一次重新查、最多 1.5 秒；期間 App 已收到結果（接單/未接）→ "-"＋islandErr resolved。
//   註冊：746＋4（delivered.seq）＝750 個（< 1000）。
final class DetectorHub {
  static let shared = DetectorHub()

  static let orderPrefix = "com.pandatimer.order."
  static let startedName = "com.pandatimer.broadcast.started"
  static let stoppedName = "com.pandatimer.broadcast.stopped"
  static let heartbeatName = "com.pandatimer.broadcast.heartbeat"
  static let drainName = "com.pandatimer.drain"
  static let maxMinutes = 90
  static let seqMod = 4
  static let offerPendingPrefix = "com.pandatimer.offer.pending."
  static let offerClearedName = "com.pandatimer.offer.cleared"
  /// v1.0：offer.cleared.<原因>（＝src/detector.ts OFFER_CLEAR_REASONS；不帶原因的舊名稱仍註冊，原因＝nil）
  static let offerClearedPrefix = "com.pandatimer.offer.cleared."
  static let offerClearReasons = ["reject", "timeout", "stopped"]
  /// v1.0 extension 狀態（心跳後送）
  static let extModeAwayName = "com.pandatimer.ext.mode.away"
  static let extModeNormalName = "com.pandatimer.ext.mode.normal"
  static let extMemPrefix = "com.pandatimer.ext.mem."
  static let extPeakPrefix = "com.pandatimer.ext.peak."
  static let maxExtMB = 80
  /// v1.0：偵測卡「已偵測邀請」最多顯示幾秒（沒收到 cleared/order 也自動回待命）＝src/offerIsland.ts OFFER_ISLAND_SECONDS
  static let offerIslandSeconds: TimeInterval = 60
  static let deliveredName = "com.pandatimer.delivered"
  static let acceptDelayPrefix = "com.pandatimer.accept.delay."
  static let maxAcceptDelay = 60
  /// 延遲訊號與 order 訊號配對的時間窗（秒）
  static let delayPairWindow: TimeInterval = 2
  static let offerStackedName = "com.pandatimer.offer.stacked"
  static let deliveredDelayPrefix = "com.pandatimer.delivered.delay."
  static let maxDeliveredDelay = 60
  /// v1.1：送達對到接單槽（＝src/detector.ts DELIVERED_SEQ_PREFIX）
  static let deliveredSeqPrefix = "com.pandatimer.delivered.seq."
  /// v1.1：「槽 → 訂單 id」保存鍵、有效時間（＝src/detector.ts SLOT_KEEP_MS）
  static let seqOrdersKey = "pandatimer.native.seqOrders.v1"
  static let seqKeepSeconds: TimeInterval = 4 * 3600
  /// 「偵測停止了」通知最短間隔（秒）＝src/detector.ts STOP_NOTICE_REPEAT_SEC
  static let stopNoticeRepeatSeconds: TimeInterval = 60
  /// 通知 userInfo 的 pandatimer 值：點了 JS 自動叫出廣播視窗（＝src/detector.ts REDETECT_TAG）
  static let redetectTag = "redetect"

  enum Signal {
    case order(Int, Int)
    case started
    case stopped
    case heartbeat
    case drain
    case offerPending(Int)
    /// v1.0：原因 reject / timeout / stopped；舊名稱（不帶原因）→ nil
    case offerCleared(String?)
    case acceptDelay(Int)
    case delivered
    case offerStacked
    case deliveredDelay(Int)
    case deliveredSeq(Int)
    case extMode(away: Bool)
    case extMem(Int)
    case extPeak(Int)
  }

  /// 純數字、無前導 0（"0" 本身可以）、在 lo…hi 之間
  private static func plainInt(_ text: String, _ lo: Int, _ hi: Int) -> Int? {
    guard !text.isEmpty, text.count <= 2, text == "0" || !text.hasPrefix("0"),
          text.allSatisfy({ $0 >= "0" && $0 <= "9" }), let n = Int(text), n >= lo, n <= hi
    else { return nil }
    return n
  }

  static func parse(_ name: String) -> Signal? {
    switch name {
    case startedName: return .started
    case stoppedName: return .stopped
    case heartbeatName: return .heartbeat
    case drainName: return .drain
    case offerClearedName: return .offerCleared(nil)
    case deliveredName: return .delivered
    case offerStackedName: return .offerStacked
    case extModeAwayName: return .extMode(away: true)
    case extModeNormalName: return .extMode(away: false)
    default: break
    }
    if name.hasPrefix(offerClearedPrefix) {
      let reason = String(name.dropFirst(offerClearedPrefix.count))
      return offerClearReasons.contains(reason) ? .offerCleared(reason) : nil
    }
    if name.hasPrefix(extMemPrefix) {
      return plainInt(String(name.dropFirst(extMemPrefix.count)), 0, maxExtMB).map { Signal.extMem($0) }
    }
    if name.hasPrefix(extPeakPrefix) {
      return plainInt(String(name.dropFirst(extPeakPrefix.count)), 0, maxExtMB).map { Signal.extPeak($0) }
    }
    if name.hasPrefix(deliveredSeqPrefix) {
      return plainInt(String(name.dropFirst(deliveredSeqPrefix.count)), 0, seqMod - 1).map { Signal.deliveredSeq($0) }
    }
    if name.hasPrefix(deliveredDelayPrefix) {
      return plainInt(String(name.dropFirst(deliveredDelayPrefix.count)), 0, maxDeliveredDelay).map {
        Signal.deliveredDelay($0)
      }
    }
    if name.hasPrefix(offerPendingPrefix) {
      return plainInt(String(name.dropFirst(offerPendingPrefix.count)), 1, maxMinutes).map { Signal.offerPending($0) }
    }
    if name.hasPrefix(acceptDelayPrefix) {
      return plainInt(String(name.dropFirst(acceptDelayPrefix.count)), 0, maxAcceptDelay).map { Signal.acceptDelay($0) }
    }
    guard name.hasPrefix(orderPrefix) else { return nil }
    let parts = String(name.dropFirst(orderPrefix.count)).split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 2 else { return nil }
    let minText = String(parts[0])
    let seqText = String(parts[1])
    guard !minText.isEmpty, minText.count <= 2, !minText.hasPrefix("0"),
          minText.allSatisfy({ $0 >= "0" && $0 <= "9" }), let n = Int(minText), n >= 1, n <= maxMinutes,
          seqText.count == 1, let s = Int(seqText), s >= 0, s < seqMod
    else { return nil }
    return .order(n, s)
  }

  /// 4 個狀態名稱＋90×4 個 order.N.S＋v0.7 的 90 個 offer.pending.N、offer.cleared、61 個 accept.delay.D（共 516 個）
  static func allNames() -> [String] {
    var names = [startedName, stoppedName, heartbeatName, drainName]
    for n in 1...maxMinutes {
      for s in 0..<seqMod { names.append("\(orderPrefix)\(n).\(s)") }
    }
    for n in 1...maxMinutes { names.append("\(offerPendingPrefix)\(n)") }
    names.append(offerClearedName)
    names.append(deliveredName)
    for d in 0...maxAcceptDelay { names.append("\(acceptDelayPrefix)\(d)") }
    names.append(offerStackedName)
    for d in 0...maxDeliveredDelay { names.append("\(deliveredDelayPrefix)\(d)") }
    for r in offerClearReasons { names.append("\(offerClearedPrefix)\(r)") }
    names.append(extModeAwayName)
    names.append(extModeNormalName)
    for m in 0...maxExtMB { names.append("\(extMemPrefix)\(m)") }
    for m in 0...maxExtMB { names.append("\(extPeakPrefix)\(m)") }
    for s in 0..<seqMod { names.append("\(deliveredSeqPrefix)\(s)") }
    return names
  }

  // MARK: - 狀態（只在 queue 上存取）

  private let queue = DispatchQueue(label: "com.pandatimer.detector.hub")
  let keepAlive = KeepAlive()
  /// v0.6 遠端狀態回報（App 端）
  let telemetry = PandaTelemetry(source: "app")
  /// v0.6 遠端設定（App 端用 app.beatTimeoutSeconds、telemetry 批次；快取同時給主 App 的 intents 用 PickerConfig.cached()）
  let remote = RemoteConfig()
  private var lastConfigFetch: Date?
  private var registered = false
  private var emitter: (([String: Any?]) -> Void)?
  private var watchdog: DispatchSourceTimer?

  private var armed = false
  private var armedAt: Date?
  private var lastBeat: Date?
  private var lastTick = Date()
  private var lastOrderMinutes: Int?
  private var lastOrderAt: Date?
  private var lastOrderHow = ""
  private var islandCheck = ""
  private var autoCount = 0
  private var beatAlerted = false
  private var lastSeq: Int?
  private var missedSignals = 0
  /// v0.7：extension 看到邀請、還沒判定（App 顯示「偵測到邀請 N 分，等你接單…」）
  private var offerPendingMinutes: Int?
  private var offerPendingAt: Date?
  /// v0.7：最近一次判定結果（「已接單 27 分（18:02:11）」／「未接單 27 分（…）」）
  private var offerNote = ""
  /// v0.7：最近收到、還沒配對的延遲訊號
  private var pendingDelay: (seconds: Int, at: Date)?
  /// v0.8：最近收到、還沒配對的夾單訊號／送達延遲訊號
  private var pendingStackedAt: Date?
  private var pendingDeliveredDelay: (seconds: Int, at: Date)?
  /// v0.8：偵測中卻收到 stopped 的時間（重新開始/停止偵測後清掉）、上次發「偵測停止了」通知的時間
  private var stoppedUnexpectedAt: Date?
  private var lastStopNoticeAt: Date?
  /// v0.8：鎖屏狀態（protectedData 通知；裝置沒設密碼時收不到 → nil）
  private var lockedAt: Date?
  private var unlockedAt: Date?
  private var lockObservers: [NSObjectProtocol] = []
  /// fg / bg / unknown（OnAppBecomesActive / OnAppEntersBackground 更新）
  private var appState = "unknown"
  private var lastKeepLogged = ""

  private let watchdogInterval = 30
  private var beatTimeout: TimeInterval = 150
  /// v0.9：心跳 update 節流、省電判定設定、心跳略過的 update 次數
  private var cardRefresh: TimeInterval = 300
  private var lastCardPushAt: Date?
  private var cardSkips = 0
  private var power = RemoteConfig.PowerSettings()
  /// v1.0：偵測卡上顯示中的邀請（偵測時間；nil＝沒有）、偵測卡 update 串行鏈
  private var offerShownAt: Date?
  private var cardTail: Task<Void, Never>?
  /// v1.0：extension 最近一次回報的模式/記憶體（Darwin ext.*）
  private var extAway: Bool?
  private var extMemMB: Int?
  private var extPeakMB: Int?
  private var extAt: Date?
  /// v1.1：order 訊號的槽 → 自動單 id（delivered.seq.<槽> 用）；nil＝還沒從 UserDefaults 載入
  private var seqOrders: [Int: (id: String, at: Date)]?

  // MARK: - 對外（由 LiveActivityModule 呼叫）

  func attach(_ emit: @escaping ([String: Any?]) -> Void) {
    queue.async {
      self.emitter = emit
      self.applyConfig()
      self.observeLockIfNeeded()
    }
  }

  /// v0.8：鎖屏/解鎖（需裝置有密碼；App 要活著——偵測中有定位保活）→ telemetry lock/unlock，對照 broadcast 停止原因
  private func observeLockIfNeeded() {
    guard lockObservers.isEmpty else { return }
    let center = NotificationCenter.default
    lockObservers.append(
      center.addObserver(
        forName: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil, queue: nil
      ) { [weak self] _ in
        self?.queue.async {
          guard let self = self else { return }
          self.lockedAt = Date()
          self.telemetry.log("lock", self.appFields(), urgent: self.armed)
        }
      })
    lockObservers.append(
      center.addObserver(
        forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: nil
      ) { [weak self] _ in
        self?.queue.async {
          guard let self = self else { return }
          let now = Date()
          var fields = self.appFields()
          if let at = self.lockedAt { fields["lockAge"] = Int(now.timeIntervalSince(at)) }
          self.lockedAt = nil
          self.unlockedAt = now
          self.telemetry.log("unlock", fields)
        }
      })
  }

  // MARK: - 遠端設定（只在 queue 上）

  private func applyConfig() {
    let root = remote.snapshot()
    beatTimeout = RemoteConfig.beatTimeout(root)
    cardRefresh = RemoteConfig.cardRefreshSeconds(root)
    power = RemoteConfig.power(root)
    let k = RemoteConfig.keepAlive(root)
    keepAlive.configure(accuracy: k.locationAccuracy, distanceFilterM: k.distanceFilterM)
    let t = RemoteConfig.telemetry(root)
    telemetry.configure(flushSeconds: t.flushSeconds, batchSize: t.batchSize)
    telemetry.setContext(["cfg": RemoteConfig.version(root)])
  }

  /// 抓遠端設定（逾時 3 秒；失敗沿用快取/預設）。force=false 時 60 秒內不重抓
  private func refreshConfig(force: Bool) {
    let now = Date()
    if !force, let last = lastConfigFetch, now.timeIntervalSince(last) < 60 { return }
    lastConfigFetch = now
    remote.refresh(timeout: 3) { [weak self] changed in
      guard let self = self else { return }
      self.queue.async {
        if changed {
          self.applyConfig()
          self.telemetry.log("config", ["cfg": self.remote.version, "note": "updated"], urgent: true)
          self.pushCard(note: "遠端設定已更新 \(self.remote.version)")
        } else if let err = self.remote.error {
          self.telemetry.log("config", ["cfg": self.remote.version, "reason": err])
        }
      }
    }
  }

  /// 註冊 4 個狀態名稱＋360 個 order.N.S。Darwin 回呼在主執行緒，進來後一律轉到 queue。
  func registerIfNeeded() {
    DispatchQueue.main.async {
      guard !self.registeredOnMain else { return }
      self.registeredOnMain = true
      let center = CFNotificationCenterGetDarwinNotifyCenter()
      let observer = Unmanaged.passUnretained(self).toOpaque()
      for name in Self.allNames() {
        CFNotificationCenterAddObserver(
          center, observer,
          { _, _, cfName, _, _ in
            guard let raw = cfName?.rawValue else { return }
            DetectorHub.shared.receive(raw as String)
          },
          name as CFString, nil, .deliverImmediately)
      }
      self.queue.async { self.registered = true }
    }
  }
  private var registeredOnMain = false  // 只在主執行緒存取

  /// App「開始偵測」（前景）：開始保活（定位優先、音訊備援）＋看門狗
  func arm() {
    queue.async {
      self.armed = true
      self.armedAt = Date()
      self.beatAlerted = false
      self.lastSeq = nil
      self.stoppedUnexpectedAt = nil
      self.keepAlive.start()
      self.startWatchdog()
      self.refreshConfig(force: true)
      DevicePower.refresh()
      self.telemetry.log("arm", self.appFields().merging(DevicePower.fields()) { $1 }, urgent: true)
    }
  }

  /// App「停止偵測」：停保活（定位＋音訊）；偵測卡若在倒數就交還給那些單（heartbeat=nil），否則結束
  func disarm() async {
    queue.sync {
      self.armed = false
      self.stoppedUnexpectedAt = nil
      self.offerShownAt = nil
      self.keepAlive.stop()
      self.stopWatchdog()
      self.telemetry.log("disarm", self.appFields().merging(DevicePower.fields()) { $1 })
    }
    for activity in Activity<PandaTimerAttributes>.activities where Self.isDetectorCard(activity) {
      var state = activity.content.state
      if state.mode == "countdown" && !DetectorCardPlan.items(cardId: activity.id).isEmpty {
        state.heartbeat = nil
        Self.clearOfferFields(&state)
        state.diag = "偵測已停止（這張倒數保留）"
        await activity.update(ActivityContent(state: state, staleDate: state.deadline))
      } else {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }
  }

  /// JS 傳來的回報情境（目前只有 OTA 更新 id "upd"）
  func setTelemetryContext(_ fields: [String: Any]) {
    telemetry.setContext(fields)
  }

  func statusJSON() -> String {
    let dict: [String: Any] = queue.sync {
      let keep = keepAlive.snapshot()
      let tele = telemetry.snapshot()
      var d: [String: Any] = [
        "registered": registered,
        "armed": armed,
        "keepAlive": keep.text,
        "keepAliveMode": keep.mode,
        "locationAuth": keep.locationAuth,
        "autoCountSinceLaunch": autoCount,
        "lastOrderHow": lastOrderHow,
        "islandCheck": islandCheck,
        "telemetryPending": tele.pending,
        "configVersion": remote.version,
      ]
      if let b = lastBeat { d["lastBeatAt"] = Self.ms(b) }
      if let m = lastOrderMinutes { d["lastOrderMinutes"] = m }
      if let at = lastOrderAt { d["lastOrderAt"] = Self.ms(at) }
      if let e = keep.error { d["keepAliveError"] = e }
      if let fix = keep.lastFixAt { d["lastFixAt"] = Self.ms(fix) }
      if let ok = tele.lastOk { d["telemetryLastOk"] = Self.ms(ok) }
      if let e = tele.lastError { d["telemetryError"] = e }
      if let m = offerPendingMinutes, let at = offerPendingAt {
        d["offerPendingMinutes"] = m
        d["offerPendingAt"] = Self.ms(at)
      }
      if !offerNote.isEmpty { d["offerNote"] = offerNote }
      if let at = stoppedUnexpectedAt { d["stoppedUnexpectedAt"] = Self.ms(at) }
      // v1.0 省電/記憶體（src/detector.ts parseDetectorStatus → power）：低電量/溫度/省電倍率＝App 自己看（同一支手機、
      // 同一套 power 規則＝extension 的判定）；電量＝DevicePower 快取；模式/記憶體＝extension 心跳後的 ext.* 訊號
      let saver = RemoteConfig.deviceSaver(power)
      d["lowPower"] = saver.lowPower
      d["thermal"] = saver.thermal
      d["saver"] = saver.saver
      let dev = DevicePower.fields()
      if let b = dev["batt"] { d["batt"] = b }
      if let c = dev["charging"] { d["charging"] = c }
      if let away = extAway { d["extMode"] = away ? "away" : "normal" }
      if let m = extMemMB { d["memMB"] = m }
      if let m = extPeakMB { d["peakMB"] = m }
      if let at = extAt { d["extAt"] = Self.ms(at) }
      return d
    }
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []),
          let text = String(data: data, encoding: .utf8)
    else { return "{}" }
    return text
  }

  /// App 回到前景（含點「偵測到新單」通知打開 App）：
  /// 偵測卡上還掛著單 → 依進行中鏡像把卡片重推一次（背景更新可能被系統擋掉或沒重繪，前景一定可以）＋回讀檢查；
  /// 沒有單 → 照舊只更新心跳/診斷字。不會重複記錄訂單（只改卡，不寫事件）。
  func appBecameActive() {
    queue.async {
      self.appState = "fg"
      DevicePower.refresh()
      self.telemetry.log("fg", self.appFields())
      self.refreshConfig(force: false)
      self.keepAlive.ensure()
      let tracking = self.armed || self.lastBeat != nil
      Task {
        if let result = await Self.refreshDetectorCard(reason: "回前景重推") {
          self.queue.async {
            self.islandCheck = result.text
            self.telemetry.log("restore", self.appFields().merging(result.fields) { $1 })
            self.emit(["type": "restored", "how": result.text])
          }
        } else if tracking {
          self.queue.async { self.pushCard(note: nil) }
        }
      }
    }
  }

  func appEnteredBackground() {
    queue.async {
      self.appState = "bg"
      self.telemetry.log("bg", self.appFields())
    }
  }

  // MARK: - 訊號處理

  private func receive(_ name: String) {
    guard let signal = Self.parse(name) else { return }
    queue.async { self.handle(signal) }
  }

  private func handle(_ signal: Signal) {
    let now = Date()
    switch signal {
    case .started:
      lastBeat = now
      beatAlerted = false
      lastSeq = nil  // extension 每次開始序號從 0 算
      setSeqOrders([:])  // v1.1：槽 → 訂單的對應跟著作廢
      stoppedUnexpectedAt = nil
      clearOffer()
      if !armed {
        // 使用者從控制中心直接開廣播、App 剛好還活著：試著保活（背景啟動定位/音訊可能被拒，結果寫進狀態）
        armed = true
        armedAt = now
        keepAlive.start()
        startWatchdog()
      }
      pushCard(note: "偵測已啟動")
      DevicePower.refresh()
      telemetry.log(
        "sig", appFields().merging(["note": "started"]) { $1 }.merging(DevicePower.fields()) { $1 }, urgent: true)
      emit(["type": "started"])
    case .heartbeat:
      lastBeat = now
      beatAlerted = false
      pushCard(note: nil, throttle: true)
      var fields = appFields().merging(DevicePower.fields()) { $1 }
      fields["cardSkip"] = cardSkips
      telemetry.log("beat", fields)
      DevicePower.refresh()  // 下一次 beat 用（UIDevice 要在主執行緒讀）
      emit(["type": "heartbeat"])
    case .stopped:
      // v0.8：使用者沒按「停止偵測」（仍 armed）＝非預期停止 → 通知可一鍵重新開始
      let unexpected = armed
      lastBeat = now
      armed = false
      keepAlive.stop()
      stopWatchdog()
      clearOffer()
      var fields = appFields().merging(["note": "stopped"]) { $1 }.merging(DevicePower.fields()) { $1 }
      fields["locked"] = lockedAt != nil
      if let at = lockedAt { fields["lockAge"] = Int(now.timeIntervalSince(at)) }
      fields["reason"] = unexpected ? "unexpected" : "userStopped"
      telemetry.log("sig", fields, urgent: true)
      if unexpected {
        stoppedUnexpectedAt = now
        pushCard(note: "⏹ 偵測已停止（點通知重新開始）\(Self.hms(now))", stopping: true)
        if lastStopNoticeAt.map({ now.timeIntervalSince($0) >= Self.stopNoticeRepeatSeconds }) ?? true {
          lastStopNoticeAt = now
          Task {
            await DetectorNotify.post(
              title: "🐼 偵測停止了，點我重新開始",
              body: "螢幕廣播在 \(Self.hms(now)) 停止了。點這則通知打開 App，再按一次「開始直播」就恢復偵測。",
              passive: false, userInfo: ["pandatimer": Self.redetectTag])
          }
        }
      } else {
        pushCard(note: "偵測已停止 \(Self.hms(now))", stopping: true)
      }
      emit(["type": "stopped", "unexpected": unexpected])
    case .drain:
      emit(["type": "drain"])
    case .order(let minutes, let seq):
      handleOrder(minutes, seq: seq, at: now)
    case .offerPending(let minutes):
      offerPendingMinutes = minutes
      offerPendingAt = now
      offerNote = ""
      telemetry.log("sig", appFields().merging(["note": "offerPending", "min": minutes]) { $1 })
      emit(["type": "offer", "minutes": minutes])
      showOffer(minutes, at: now)
    case .offerCleared(let reason):
      let minutes = offerPendingMinutes
      clearOffer()
      offerNote = "未接單" + (minutes.map { " \($0) 分" } ?? "") + "（\(Self.hms(now))"
        + (reason.map { "・\(Self.clearReasonText($0))" } ?? "") + "）"
      var fields = appFields().merging(["note": "offerCleared"]) { $1 }
      if let r = reason { fields["reason"] = r }
      if let m = minutes { fields["min"] = m }
      telemetry.log("sig", fields)
      var body: [String: Any?] = ["type": "offerCleared"]
      if let r = reason { body["reason"] = r }
      if let m = minutes { body["minutes"] = m }
      emit(body)
      hideOffer(match: nil, note: "未接單" + (minutes.map { " \($0) 分" } ?? "") + " \(Self.hms(now))")
    case .acceptDelay(let seconds):
      pendingDelay = (seconds: seconds, at: now)
    case .offerStacked:
      pendingStackedAt = now
    case .deliveredDelay(let seconds):
      pendingDeliveredDelay = (seconds: seconds, at: now)
    case .delivered:
      handleDelivered(at: now, slot: nil)
    case .deliveredSeq(let slot):
      handleDelivered(at: now, slot: slot)
    case .extMode(let away):
      extAway = away
      extAt = now
    case .extMem(let mb):
      extMemMB = mb
      extAt = now
    case .extPeak(let mb):
      extPeakMB = mb
      extAt = now
    }
  }

  static func clearReasonText(_ reason: String) -> String {
    switch reason {
    case "reject": return "拒單"
    case "stopped": return "偵測停止"
    default: return "逾時"
    }
  }

  // MARK: - v1.0 偵測到邀請 → 動態島（只在 queue 上呼叫）

  /// 平台確切報酬（元）＝src/orders.ts exactFare：max(45, floor(分×245/60＋0.01))；用整數分計算
  static func offerFare(_ minutes: Int) -> Double {
    let cents = minutes * 24500 / 60 + 1
    return Double(max(4500, cents)) / 100
  }

  static func offerAlertTitle(_ minutes: Int) -> String { "已偵測 \(minutes) 分邀請" }
  static let offerAlertBody = "可以按接受訂單"
  static let offerAlertBodyCounting = "可以按接受訂單・倒數照常進行"

  /// 偵測卡 update 串成一條（前一個做完才做下一個）
  private func enqueueCard(_ work: @escaping () async -> Void) {
    let previous = cardTail
    cardTail = Task {
      await previous?.value
      await work()
    }
  }

  /// 卡片待命 → mode "offer"；卡片倒數中 → 不蓋倒數、只寫邀請欄位。都帶 alertConfiguration（展開＋重繪）。
  private func showOffer(_ minutes: Int, at: Date) {
    let island = RemoteConfig.offerIsland(remote.snapshot())
    guard island.islandIndicator else { return }
    let amount = Self.offerFare(minutes)
    let beat = lastBeat ?? at
    let diag = diagText(note: "偵測到邀請 \(minutes) 分 \(Self.hms(at))")
    let silent = island.alertSound == "none"
    let baseFields = appFields()
    offerShownAt = at
    queue.asyncAfter(deadline: .now() + Self.offerIslandSeconds) { [weak self] in
      guard let self = self, self.offerShownAt == at else { return }
      self.offerShownAt = nil
      self.hideOffer(match: at, note: "邀請 \(Int(Self.offerIslandSeconds)) 秒沒有結果")
    }
    enqueueCard {
      guard let card = Self.detectorCard() else {
        self.queue.async {
          self.telemetry.log(
            "sig", baseFields.merging(["note": "offerIsland", "min": minutes, "island": "✗", "islandErr": "noCard"]) { $1 })
        }
        return
      }
      var state = card.content.state
      let counting = state.mode == "countdown"
      state.offerMin = minutes
      state.offerAmount = amount
      state.offerAt = at
      state.heartbeat = beat
      var staleDate = card.content.staleDate
      if !counting {
        state.mode = "offer"
        state.diag = diag
        // 沒收到結果也會在 60 秒後過期：widget 看 isStale 畫回「偵測中」（背景 update 不一定重繪的保險）
        staleDate = at.addingTimeInterval(Self.offerIslandSeconds)
      }
      // ⚠️ ActivityKit 沒有官方「靜音」：.named("") 找不到檔案時系統可能照樣用預設聲音（實機確認）
      let sound: AlertConfiguration.AlertSound = silent ? .named("") : .default
      let alert = AlertConfiguration(
        title: LocalizedStringResource(stringLiteral: Self.offerAlertTitle(minutes)),
        body: LocalizedStringResource(stringLiteral: counting ? Self.offerAlertBodyCounting : Self.offerAlertBody),
        sound: sound)
      await card.update(ActivityContent(state: state, staleDate: staleDate), alertConfiguration: alert)
      self.queue.async { self.lastCardPushAt = Date() }
      let cardId = card.id
      let orders = counting ? DetectorCardPlan.items(cardId: cardId).count : nil
      // v1.1：update 後同一個物件的 content 不會立刻變（v1.0 一律 ✗）→ 另開 Task 每 0.25 秒重新查（不擋住卡片串行鏈）
      Task {
        let check = await Self.verifyOffer(cardId: cardId, at: at) { self.queue.sync { self.offerShownAt == at } }
        self.queue.async {
          var fields = baseFields.merging(check) { $1 }
          fields["note"] = "offerIsland"
          fields["min"] = minutes
          if let n = orders { fields["orders"] = n }
          self.telemetry.log("sig", fields)
        }
      }
    }
  }

  /// v1.1 邀請顯示回讀：每 0.25 秒重新查卡（最多 1.5 秒）。卡上 offerAt＝這次偵測 → ✓；
  /// 期間 App 已收到結果（still() 為 false：接單/未接/逾時清掉）→ "-"＋resolved；卡沒了/結束 → ✗；時間到 → ✗ notShown
  static func verifyOffer(cardId: String, at: Date, still: @escaping () -> Bool) async -> [String: Any] {
    var waited = 0.0
    while waited < 1.5 {
      try? await Task.sleep(nanoseconds: 250_000_000)
      waited += 0.25
      guard let a = Activity<PandaTimerAttributes>.activities.first(where: { $0.id == cardId }) else {
        return ["island": "✗", "islandErr": "cardGone"]
      }
      if a.content.state.offerAt.map({ abs($0.timeIntervalSince(at)) < 1 }) ?? false {
        return ["island": "✓", "wait": waited]
      }
      if a.activityState != .active { return ["island": "✗", "islandErr": "state:\(a.activityState)"] }
      if !still() { return ["island": "-", "islandErr": "resolved", "wait": waited] }
    }
    return ["island": "✗", "islandErr": "notShown"]
  }

  /// 清掉卡上的邀請：mode "offer" → standby（倒數中只清邀請欄位）。match 非 nil → 只清偵測時間相同的那張
  private func hideOffer(match: Date?, note: String?) {
    if match == nil { offerShownAt = nil }
    let beat = lastBeat
    let text = note.map { diagText(note: $0) }
    enqueueCard {
      guard let card = Self.detectorCard() else { return }
      var state = card.content.state
      guard let shown = state.offerAt ?? (state.mode == "offer" ? Date.distantPast : nil) else { return }
      if let m = match, abs(shown.timeIntervalSince(m)) >= 1 { return }
      Self.clearOfferFields(&state)
      var staleDate = card.content.staleDate
      if state.mode == "offer" {
        state.mode = "standby"
        staleDate = nil
        if let t = text { state.diag = t }
      }
      if let b = beat { state.heartbeat = b }
      await card.update(ActivityContent(state: state, staleDate: staleDate))
      self.queue.async { self.lastCardPushAt = Date() }
    }
  }

  static func clearOfferFields(_ state: inout PandaTimerAttributes.ContentState) {
    state.offerMin = nil
    state.offerAmount = nil
    state.offerAt = nil
  }

  /// v0.8 只在 queue 上：near 前後 2 秒內收到的夾單訊號（取走就清掉；過期的也清掉）
  private func takeStacked(near: Date) -> Bool {
    guard let at = pendingStackedAt else { return false }
    if abs(at.timeIntervalSince(near)) <= Self.delayPairWindow {
      pendingStackedAt = nil
      return true
    }
    if near.timeIntervalSince(at) > Self.delayPairWindow { pendingStackedAt = nil }
    return false
  }

  /// v0.8 只在 queue 上：near 前後 2 秒內收到的送達延遲訊號
  private func takeDeliveredDelay(near: Date) -> Int? {
    guard let p = pendingDeliveredDelay else { return nil }
    if abs(p.at.timeIntervalSince(near)) <= Self.delayPairWindow {
      pendingDeliveredDelay = nil
      return p.seconds
    }
    if near.timeIntervalSince(p.at) > Self.delayPairWindow { pendingDeliveredDelay = nil }
    return nil
  }

  // MARK: - v1.1 槽 → 訂單 id（只在 queue 上；規則＝src/detector.ts slotsAfterOrder / slotTarget）

  private func loadSeqOrders() -> [Int: (id: String, at: Date)] {
    if let cached = seqOrders { return cached }
    var out: [Int: (id: String, at: Date)] = [:]
    if let dict = UserDefaults.standard.dictionary(forKey: Self.seqOrdersKey) {
      for (k, v) in dict {
        guard let slot = Int(k), slot >= 0, slot < Self.seqMod, let e = v as? [String: Any],
              let id = e["id"] as? String, let at = (e["at"] as? NSNumber)?.doubleValue
        else { continue }
        out[slot] = (id: id, at: Date(timeIntervalSince1970: at / 1000))
      }
    }
    seqOrders = out
    return out
  }

  private func setSeqOrders(_ map: [Int: (id: String, at: Date)]) {
    seqOrders = map
    var dict: [String: Any] = [:]
    for (slot, e) in map { dict[String(slot)] = ["id": e.id, "at": Self.ms(e.at)] }
    UserDefaults.standard.set(dict, forKey: Self.seqOrdersKey)
  }

  /// 收到 order：漏掉的槽（gap）清掉、這個槽指向新單
  private func noteSeqOrder(slot: Int, gap: Int, id: String, at: Date) {
    var map = loadSeqOrders()
    if gap > 0 {
      for i in 1...min(gap, Self.seqMod - 1) { map.removeValue(forKey: (slot - i + Self.seqMod * 2) % Self.seqMod) }
    }
    map[slot] = (id: id, at: at)
    setSeqOrders(map)
  }

  private func seqTarget(_ slot: Int, now: Date) -> String? {
    guard let e = loadSeqOrders()[slot], now.timeIntervalSince(e.at) < Self.seqKeepSeconds else { return nil }
    return e.id
  }

  /// v0.7 自動送達（規則＝src/deliveryDetector.ts 的 pickDeliveredOrder）；v0.8 實際時間＝收到 − 延遲訊號
  /// v1.1 slot 非 nil＝delivered.seq.<槽>：槽對到的單 → 只結那張（matched）；對不到 → 原邏輯
  private func handleDelivered(at received: Date, slot: Int?) {
    let settings = RemoteConfig.delivery(remote.snapshot())
    var baseFields = appFields()
    let matchedId = slot.flatMap { seqTarget($0, now: received) }
    baseFields["matched"] = matchedId != nil
    if let s = slot { baseFields["seq"] = s }
    if let s = slot, matchedId != nil {
      var map = loadSeqOrders()
      map.removeValue(forKey: s)
      setSeqOrders(map)
    }
    let paired = takeDeliveredDelay(near: received)
    Task {
      // 延遲訊號應該先到；沒到就再等最多 1 秒（Darwin 通知偶爾亂序）
      var delay = paired
      var waits = 0
      while delay == nil && waits < 2 {
        try? await Task.sleep(nanoseconds: 500_000_000)
        waits += 1
        delay = self.queue.sync { self.takeDeliveredDelay(near: received) }
      }
      let usedDelay = delay
      let now = received.addingTimeInterval(-Double(usedDelay ?? 0))
      let outcome = AutoDelivery.finish(settings: settings, at: now, receivedAt: received, matchedId: matchedId)
      guard case .finished(let order) = outcome else {
        if case .skipped(let reason) = outcome {
          self.queue.async {
            self.telemetry.log("delivered", baseFields.merging(["note": "skip", "reason": reason]) { $1 })
          }
        }
        return
      }
      NativeSyncDrain.post()
      if !order.notifIds.isEmpty {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: order.notifIds)
      }
      if let aid = order.activityId {
        await DetectorCardPlan.afterFinish(activityId: aid, note: "自動送達 \(Self.hm(now))")
      }
      let actual = (now.timeIntervalSince1970 * 1000 - order.acceptedAt) / 60_000
      let actualText = String(format: "%.1f", actual)
      self.queue.async {
        var fields = baseFields
        fields["note"] = "auto"
        fields["min"] = order.estimateMin
        fields["wait"] = (actual * 10).rounded() / 10
        if let d = usedDelay { fields["delay"] = d }
        self.telemetry.log("delivered", fields, urgent: true)
        self.lastOrderHow = "已自動記錄送達：實際 \(actualText) 分／預估 \(order.estimateMin) 分"
      }
      let how = matchedId != nil ? "依送達畫面的單號結對應那單" : "結截止最早那單"
      await DetectorNotify.post(
        title: "已自動記錄送達：實際 \(actualText) 分／預估 \(order.estimateMin) 分",
        body: "按下確認已送達後自動結單（送達時間 \(Self.hms(now))，\(how)）。記錯了可在 App 最近紀錄查看",
        passive: true)
    }
  }

  /// 只清 App 端的邀請狀態（卡片：order → placeOrder 的 apply 清；cleared → hideOffer；started/stopped → pushCard 自癒）
  private func clearOffer() {
    offerPendingMinutes = nil
    offerPendingAt = nil
    offerShownAt = nil
  }

  /// 只在 queue 上：取走 near 前後 delayPairWindow 秒內收到的延遲訊號（取走就清掉；過期的也清掉）
  private func takeDelay(near: Date) -> Int? {
    guard let p = pendingDelay else { return nil }
    if abs(p.at.timeIntervalSince(near)) <= Self.delayPairWindow {
      pendingDelay = nil
      return p.seconds
    }
    if near.timeIntervalSince(p.at) > Self.delayPairWindow { pendingDelay = nil }
    return nil
  }

  /// v0.6：不去重（extension 已做邊緣觸發＋去重），每則訊號＝一張新單。
  private func handleOrder(_ minutes: Int, seq: Int, at now: Date) {
    // 看門狗每 30 秒走一次；隔太久沒走＝App 曾被暫停，這個訊號可能是恢復後才送達（時間偏晚）
    let wasSuspended = watchdog != nil && now.timeIntervalSince(lastTick) > Double(watchdogInterval) * 1.5 + 5
    let gap = lastSeq.map { (seq - $0 - 1 + Self.seqMod) % Self.seqMod } ?? 0
    lastSeq = seq
    missedSignals += gap
    lastOrderMinutes = minutes
    lastOrderAt = now
    autoCount += 1
    lastOrderHow = "處理中…"
    clearOffer()
    offerNote = "已接單 \(minutes) 分（\(Self.hms(now))）"
    let pairedDelay = takeDelay(near: now)
    let pairedStacked = takeStacked(near: now)
    let beat = lastBeat ?? now
    let diag = diagText(note: "自動新單 \(minutes) 分")
    let orderId = "\(Int64(Self.ms(now)))-a\(UUID().uuidString.prefix(4).lowercased())"
    let baseFields = appFields()
    // v1.1：槽 → 這張單（送達對話框的單號對到這個槽時結它）
    noteSeqOrder(slot: seq, gap: gap, id: orderId, at: now)

    Task {
      // App 曾被暫停 → 用 extension 那則「偵測到新單」通知裡的偵測時間（找不到就用收到訊號的時間）
      var acceptedAt = now
      var timeNote = ""
      var delayUsed: Int?
      var stacked = pairedStacked
      if wasSuspended {
        if let t = await DetectorNotify.detectedAt(minutes: minutes, seq: seq, notAfter: now) {
          acceptedAt = t.date
          stacked = stacked || t.stacked
          timeNote = "（App 曾被暫停，接單時間已改用偵測通知的 \(Self.hms(t.date))）"
        } else {
          timeNote = "（⚠️ App 曾被暫停，接單時間可能偏晚）"
        }
      } else {
        // v0.7：延遲訊號應該先到；沒到就等最多 2 秒（Darwin 通知偶爾亂序）
        var delay = pairedDelay
        var waits = 0
        while delay == nil && waits < 4 {
          try? await Task.sleep(nanoseconds: 500_000_000)
          waits += 1
          delay = self.queue.sync { self.takeDelay(near: now) }
        }
        if !stacked { stacked = self.queue.sync { self.takeStacked(near: now) } }
        delayUsed = delay
        if let d = delay {
          acceptedAt = now.addingTimeInterval(-Double(d))
          if d > 0 { timeNote = "（接單時間往前修正 \(d) 秒＝按下接受的時間）" }
        } else {
          timeNote = "（沒收到延遲訊號，接單時間用收到時間）"
        }
      }
      let deadline = acceptedAt.addingTimeInterval(Double(minutes) * 60)
      let notifIds = await DetectorReminders.schedule(deadline: deadline, estimateMin: minutes)
      var order: [String: Any] = [
        "id": orderId,
        "acceptedAt": Self.ms(acceptedAt),
        "estimateMin": minutes,
        "deadline": Self.ms(deadline),
        "notifIds": notifIds,
        "source": "auto",
      ]
      // v1.1 疊單：邀請寫「夾單」＝offer；接單時鏡像裡已有其他進行中單＝carry（統計「不含夾單」兩種都排除）
      let othersActive = !NativeSync.readArray(NativeSync.activeKey).isEmpty
      let stackKind: String? = stacked ? "offer" : (othersActive ? "carry" : nil)
      let isStacked = stackKind != nil
      if let k = stackKind {
        order["stacked"] = true
        order["stackKind"] = k
      }
      let outcome = await Self.placeOrder(
        &order, minutes: minutes, acceptedAt: acceptedAt, deadline: deadline, beat: beat, diag: diag)
      let check = await Self.verifyCard(activityId: outcome.activityId, expect: outcome.expect)
      let how = outcome.text + timeNote
      let delayField = delayUsed
      self.queue.async {
        self.lastOrderHow = how
        self.islandCheck = check.text
        var fields = baseFields.merging(check.fields) { $1 }
        fields["min"] = minutes
        fields["seq"] = seq
        fields["gap"] = gap
        fields["susp"] = wasSuspended
        fields["orders"] = outcome.count
        if let d = delayField { fields["delay"] = d }
        if isStacked { fields["stacked"] = true }
        if let k = stackKind { fields["stackKind"] = k }
        if let err = outcome.requestError { fields["reason"] = err }
        self.telemetry.log("order", fields, urgent: true)
        self.emit(["type": "order", "minutes": minutes, "how": how, "check": check.text])
      }
      let gapNote = gap > 0 ? "\n⚠️ 中間有 \(gap) 則新單訊號遺失（App 可能被暫停）" : ""
      await DetectorNotify.post(
        title: "App 已記錄自動新單：\(minutes) 分" + (stackKind == "offer" ? "（夾單）" : stackKind == "carry" ? "（疊單）" : "")
          + (outcome.count > 1 ? "（進行中 \(outcome.count) 單）" : ""),
        body: "\(check.text)\n\(how)\(gapNote)\n動態島沒變的話：點「偵測到新單」通知打開 App，或長按動態島按「開始倒數」",
        passive: true)
    }
  }

  /// App 端回報共用欄位：保活模式、定位授權、前景/背景
  private func appFields() -> [String: Any] {
    let keep = keepAlive.snapshot()
    var d: [String: Any] = ["keep": keep.mode, "auth": keep.locationAuth, "fg": appState]
    if missedSignals > 0 { d["gap"] = missedSignals }
    return d
  }

  // MARK: - 動態島

  struct OrderCardOutcome {
    let activityId: String?
    /// 卡上應該顯示的主單截止時間與 others（回讀比對用）
    let expect: DetectorCardPlan.Item?
    let expectOthers: String?
    /// 這張卡上掛著的單數
    let count: Int
    let requestError: String?
    let text: String
  }

  /// 有偵測卡 → 這單掛到偵測卡（鏡像 activityId＝偵測卡 id）→ 依鏡像重排卡片（最早截止為主、others 列其餘）
  ///   並用 alertConfiguration 強制展開提示＋重繪；
  /// 沒有偵測卡 → 試背景開新卡（官方：只有前景/LiveActivityIntent 能開，背景預期被拒），失敗就只記錄＋提醒通知。
  /// 訂單一律在這裡寫進事件佇列＋進行中鏡像（NativeSync.recordStart）。
  static func placeOrder(
    _ order: inout [String: Any], minutes: Int, acceptedAt: Date, deadline: Date, beat: Date, diag: String
  ) async -> OrderCardOutcome {
    if let card = detectorCard() {
      order["activityId"] = card.id
      NativeSync.recordStart(order)
      let items = DetectorCardPlan.items(cardId: card.id)
      let total = items.count
      let alert = AlertConfiguration(
        title: LocalizedStringResource(stringLiteral: "新單 \(minutes) 分"),
        body: LocalizedStringResource(
          stringLiteral: "截止 \(hm(deadline))" + (total > 1 ? "・進行中 \(total) 單" : "")),
        sound: .default)
      let main = await DetectorCardPlan.apply(to: card, items: items, note: diag, alert: alert)
      let others = DetectorCardPlan.othersText(Array(items.dropFirst()))
      var text = "已把 \(minutes) 分掛到偵測卡（提示展開）"
      if total > 1, let m = main {
        text += "；卡上 \(total) 單，顯示最早截止 \(hm(m.deadline))"
      }
      return OrderCardOutcome(
        activityId: card.id, expect: main, expectOthers: others, count: total, requestError: nil, text: text)
    }
    // 沒有偵測卡（例如使用者從控制中心直接開廣播）：試著開新卡
    do {
      let id = try await MainActor.run { () throws -> String in
        let state = PandaTimerAttributes.ContentState(
          deadline: deadline, estimateMinutes: minutes, mode: "countdown", heartbeat: beat,
          diag: "自動偵測 \(hm(acceptedAt))")
        let activity = try Activity<PandaTimerAttributes>.request(
          attributes: PandaTimerAttributes(acceptedAt: acceptedAt),
          content: ActivityContent(state: state, staleDate: deadline),
          pushType: nil)
        return activity.id
      }
      order["activityId"] = id
      NativeSync.recordStart(order)
      let item = DetectorCardPlan.Item(
        id: order["id"] as? String ?? "", acceptedAt: acceptedAt, estimateMin: minutes, deadline: deadline)
      return OrderCardOutcome(
        activityId: id, expect: item, expectOthers: nil, count: 1, requestError: nil, text: "沒有偵測卡，新開倒數卡成功")
    } catch {
      NativeSync.recordStart(order)
      let err = error.localizedDescription
      return OrderCardOutcome(
        activityId: nil, expect: nil, expectOthers: nil, count: 0, requestError: err,
        text: "沒有偵測卡、開新卡被拒（\(err)）→ 只記錄＋提醒通知")
    }
  }

  struct CardCheck {
    let text: String
    let fields: [String: Any]
  }

  /// 更新後 1 秒回讀：同 id 的卡 content.state 是否為預期的主單（mode/deadline）。
  /// ⚠️ 讀到的是本程序 ActivityKit 的狀態；若系統（liveactivitiesd）拒絕但本地狀態已改，這裡仍會是 ✓ —
  /// 所以 ✓ 只代表「本地已改」，真正以動態島畫面為準（✗ 則一定沒更新成功）。
  static func verifyCard(activityId: String?, expect: DetectorCardPlan.Item?) async -> CardCheck {
    let place = await appStateText()
    guard let id = activityId, let want = expect else {
      return CardCheck(text: "動態島：沒有卡可更新✗（\(place)）", fields: ["island": "✗", "islandErr": "noCard"])
    }
    try? await Task.sleep(nanoseconds: 1_000_000_000)
    guard let activity = Activity<PandaTimerAttributes>.activities.first(where: { $0.id == id }) else {
      return CardCheck(text: "動態島：卡不見了✗（\(place)）", fields: ["island": "✗", "islandErr": "cardGone"])
    }
    let state = activity.content.state
    let alive = activity.activityState == .active
    let ok = alive
      && (state.mode ?? "countdown") == "countdown"
      && abs(state.deadline.timeIntervalSince(want.deadline)) < 1
    if ok {
      return CardCheck(text: "動態島：已更新✓（\(place)）", fields: ["island": "✓"])
    }
    let why = alive ? "stateMismatch" : "state:\(activity.activityState)"
    return CardCheck(text: "動態島：疑似被系統擋✗（\(place)）", fields: ["island": "✗", "islandErr": why])
  }

  static func appStateText() async -> String {
    await MainActor.run { () -> String in
      switch UIApplication.shared.applicationState {
      case .active: return "前景"
      case .inactive: return "前景切換中"
      default: return "背景"
      }
    }
  }

  /// 偵測卡上還掛著單 → 依鏡像重推（不帶 alert）＋回讀；沒有卡或沒有單 → nil。只改動態島，不寫訂單事件。
  static func refreshDetectorCard(reason: String) async -> CardCheck? {
    guard let card = detectorCard() else { return nil }
    let items = DetectorCardPlan.items(cardId: card.id)
    guard !items.isEmpty else { return nil }
    let main = await DetectorCardPlan.apply(
      to: card, items: items, note: "\(reason) \(hms(Date())) · 進行中 \(items.count) 單", alert: nil)
    let check = await verifyCard(activityId: card.id, expect: main)
    var fields = check.fields
    fields["orders"] = items.count
    return CardCheck(text: check.text, fields: fields)
  }

  static func isDetectorCard(_ activity: Activity<PandaTimerAttributes>) -> Bool {
    guard activity.activityState != .ended && activity.activityState != .dismissed else { return false }
    let state = activity.content.state
    return state.mode == "standby" || state.mode == "stopped" || state.mode == "offer" || state.heartbeat != nil
  }

  static func detectorCard() -> Activity<PandaTimerAttributes>? {
    let all = Activity<PandaTimerAttributes>.activities.filter(isDetectorCard)
    return all.first { $0.content.state.mode == "standby" || $0.content.state.mode == "offer" }
      ?? all.first { $0.content.state.mode == "countdown" }
      ?? all.first { $0.content.state.mode == "stopped" }
      ?? all.first
  }

  /// 只更新心跳與診斷字（倒數內容不動）。stopping：非倒數中的卡改成「偵測已停止」。
  /// v0.9 throttle（只有心跳用）：卡上的診斷字去掉心跳時間後一樣、模式不變、且距上次 update 未滿 cardRefreshSeconds → 不 update
  /// （省 Live Activity 更新；心跳停了由看門狗 150 秒逾時強制 update 警告）。
  private func pushCard(note: String?, stopping: Bool = false, throttle: Bool = false) {
    let text = diagText(note: note)
    let beat = lastBeat ?? Date()
    let now = Date()
    let due = !throttle || lastCardPushAt.map { now.timeIntervalSince($0) >= cardRefresh } ?? true
    let offerAt = offerShownAt
    enqueueCard {
      guard let activity = Self.detectorCard() else { return }
      let current = activity.content
      var state = current.state
      let counting = state.mode == "countdown" && state.deadline > Date()
      // v1.0 自癒：卡上的邀請不是 App 目前顯示中的那張（已結案、停止、重新開始、App 重開）→ 清掉
      let offerLive = state.offerAt.map { at in offerAt.map { abs($0.timeIntervalSince(at)) < 1 } ?? false } ?? false
      if stopping || !offerLive {
        Self.clearOfferFields(&state)
        if state.mode == "offer" { state.mode = "standby" }
      }
      if stopping {
        if !counting { state.mode = "stopped" }
      } else if state.mode == "stopped" {
        state.mode = "standby"
      }
      if !due && state.mode == current.state.mode && state.offerAt == current.state.offerAt
        && Self.stableDiag(current.state.diag) == Self.stableDiag(text)
      {
        self.queue.async { self.cardSkips += 1 }
        return
      }
      state.heartbeat = beat
      // 邀請顯示中：診斷字留著「偵測到邀請」那行，只更新心跳
      if state.mode != "offer" { state.diag = text }
      let staleDate = state.mode == "countdown" || state.mode == "offer" ? current.staleDate : nil
      self.queue.async { self.lastCardPushAt = Date() }
      await activity.update(ActivityContent(state: state, staleDate: staleDate))
    }
  }

  /// 診斷字去掉心跳時間（「App 已收到心跳 12:34:56」→「App 已收到心跳」），比較「實質變化」用
  static func stableDiag(_ text: String?) -> String {
    guard let text = text else { return "" }
    return text.replacingOccurrences(
      of: "App 已收到心跳 [0-9]{1,2}:[0-9]{2}:[0-9]{2}", with: "App 已收到心跳", options: .regularExpression)
  }

  private func diagText(note: String?) -> String {
    var parts: [String] = []
    if let note = note { parts.append(note) }
    if let beat = lastBeat {
      parts.append("App 已收到心跳 \(Self.hms(beat))")
    } else {
      parts.append("App 尚未收到心跳")
    }
    parts.append("保活:\(keepAlive.snapshot().text)")
    // v0.9：低電量模式/過熱 → extension 所有間隔 ×saverFactor（同一套規則，各程序自己看 ProcessInfo）
    if RemoteConfig.deviceSaver(power).saver { parts.append("省電中") }
    parts.append("設定 \(remote.version)")
    if let m = lastOrderMinutes, let at = lastOrderAt {
      parts.append("最近新單:\(m)分 \(Self.hm(at))")
    }
    return parts.joined(separator: " · ")
  }

  // MARK: - 看門狗（30 秒）：記錄「App 還活著」、補播備援音訊、心跳逾時警告、保活狀態變化回報

  private func startWatchdog() {
    guard watchdog == nil else { return }
    lastTick = Date()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(
      deadline: .now() + .seconds(watchdogInterval), repeating: .seconds(watchdogInterval), leeway: .seconds(3))
    timer.setEventHandler { [weak self] in self?.tick() }
    timer.resume()
    watchdog = timer
  }

  private func stopWatchdog() {
    watchdog?.cancel()
    watchdog = nil
  }

  private func tick() {
    let now = Date()
    lastTick = now
    guard armed else { return }
    keepAlive.ensure()
    if lastConfigFetch.map({ now.timeIntervalSince($0) >= RemoteConfig.refreshSeconds(remote.snapshot()) }) ?? true {
      refreshConfig(force: true)
    }
    let keep = keepAlive.snapshot()
    let keepTag = "\(keep.mode)|\(keep.locationAuth)|\(keep.error ?? "")|\(keep.accuracyText)"
    if keepTag != lastKeepLogged {
      lastKeepLogged = keepTag
      var fields = appFields()
      if let e = keep.error { fields["reason"] = e }
      fields["note"] = keep.accuracyText
      telemetry.log("keep", fields, urgent: keep.error != nil)
    }
    let since = lastBeat ?? armedAt ?? now
    let gap = now.timeIntervalSince(since)
    if gap > beatTimeout && !beatAlerted {
      beatAlerted = true
      let minutes = Int((gap / 60).rounded())
      let note = lastBeat == nil ? "⚠️ 還沒收到偵測訊號（廣播沒開始？）" : "⚠️ \(minutes) 分鐘沒收到偵測心跳"
      pushCard(note: note)
      emit(["type": "beatTimeout"])
      var fields = appFields()
      fields["beatAge"] = Int(gap)
      telemetry.log("beatTimeout", fields, urgent: true)
      let body = "\(note)。偵測可能已被系統關掉，請重新開始偵測。"
      Task {
        await DetectorNotify.post(
          title: "🐼 偵測沒有回應", body: body + "點這則通知可直接重新開始。", passive: false,
          userInfo: ["pandatimer": Self.redetectTag])
      }
    }
  }

  private func emit(_ body: [String: Any?]) {
    guard let emitter = emitter else { return }
    DispatchQueue.main.async { emitter(body) }
  }

  // MARK: - 工具

  static func ms(_ date: Date) -> Double {
    (date.timeIntervalSince1970 * 1000).rounded()
  }

  private static let hmsFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "zh_Hant_TW")
    f.dateFormat = "HH:mm:ss"
    return f
  }()

  private static let hmFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "zh_Hant_TW")
    f.dateFormat = "HH:mm"
    return f
  }()

  static func hms(_ date: Date) -> String { hmsFormatter.string(from: date) }
  static func hm(_ date: Date) -> String { hmFormatter.string(from: date) }
}

// MARK: - 保活（v0.5）：背景定位優先；定位授權被拒或定位失敗才用靜音音訊備援
// 定位正常時不播音訊，避免程序被判成「只播背景媒體」而不准更新動態島。
// CLLocationManager 只在主執行緒建立/存取（delegate 回呼也在主執行緒）。

final class KeepAlive: NSObject, CLLocationManagerDelegate {
  struct Snapshot {
    let wanted: Bool
    /// none / auth（等授權）/ location / audio（備援）
    let mode: String
    let audio: AudioKeepAlive.Snapshot
    let locationAuth: String
    let lastFixAt: Date?
    let error: String?
    /// v0.9：目前套用的精度/距離過濾（例 "hundred/50m"）
    let accuracyText: String

    var text: String {
      guard wanted else { return "無" }
      switch mode {
      case "location": return "定位中"
      case "auth": return "等待定位授權"
      case "audio":
        if audio.playing { return "音訊中(備援)" }
        return audio.interrupted ? "音訊備援中斷" : "音訊備援失敗"
      default: return "無"
      }
    }
  }

  private let audio = AudioKeepAlive()
  private let lock = NSLock()
  private struct Published {
    var wanted = false
    var mode = "none"
    var auth = "unknown"
    var fix: Date?
    var error: String?
    var accuracy = "hundred/50m"
  }
  private var published = Published()

  // 只在主執行緒存取
  private var manager: CLLocationManager?
  private var backgroundSession: AnyObject?  // iOS 17 CLBackgroundActivitySession
  private var wanted = false
  private var mode = "none"
  private var fallbackReason: String?  // "denied" | "failed"
  private var locationError: String?
  private(set) var lastLocation: CLLocation?  // 以後做到點提醒用；本版只存記憶體
  /// v0.9 遠端設定 keepAlive（只在主執行緒）：保活只需要 App 不被暫停，不需要精準位置
  private var accuracyName = "hundred"
  private var distanceFilterM = 50

  func snapshot() -> Snapshot {
    lock.lock()
    let p = published
    lock.unlock()
    let audioSnap = audio.snapshot()
    var error = p.error
    if p.mode == "audio", let e = audioSnap.error { error = (error.map { $0 + "；" } ?? "") + "音訊：\(e)" }
    return Snapshot(
      wanted: p.wanted, mode: p.mode, audio: audioSnap, locationAuth: p.auth, lastFixAt: p.fix, error: error,
      accuracyText: p.accuracy)
  }

  func start() {
    onMain {
      self.wanted = true
      self.setupManager()
      self.apply()
    }
  }

  func stop() {
    onMain {
      self.wanted = false
      self.manager?.stopUpdatingLocation()
      self.invalidateBackgroundSession()
      self.audio.stop()
      self.mode = "none"
      self.fallbackReason = nil
      self.locationError = nil
      self.publish()
    }
  }

  /// 看門狗/回前景：備援音訊被中斷就補播；定位模式不用動
  func ensure() {
    onMain {
      guard self.wanted else { return }
      if self.mode == "audio" { self.audio.ensurePlaying() }
    }
  }

  /// v0.9 遠端設定 keepAlive.locationAccuracy（"hundred"|"kilometer"|"threeKilometers"）/ distanceFilterM（0＝不過濾）。
  /// ⚠️ Apple（論壇 727015）：iOS 16.4 起「低精度＋距離過濾」可能在背景被暫停，除非 showsBackgroundLocationIndicator=true
  /// （本 App 有開）→ 預設維持 hundred/50（v0.5 實測可行），低精度要看 telemetry 對照後再切。
  func configure(accuracy: String, distanceFilterM: Int) {
    onMain {
      guard accuracy != self.accuracyName || distanceFilterM != self.distanceFilterM else { return }
      self.accuracyName = accuracy
      self.distanceFilterM = distanceFilterM
      if let m = self.manager { self.applyAccuracy(m) }
      self.publish()
    }
  }

  private func applyAccuracy(_ m: CLLocationManager) {
    switch accuracyName {
    case "kilometer": m.desiredAccuracy = kCLLocationAccuracyKilometer
    case "threeKilometers": m.desiredAccuracy = kCLLocationAccuracyThreeKilometers
    default: m.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }
    m.distanceFilter = distanceFilterM > 0 ? CLLocationDistance(distanceFilterM) : kCLDistanceFilterNone
  }

  private func onMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
  }

  private func setupManager() {
    guard manager == nil else { return }
    let m = CLLocationManager()
    m.delegate = self
    applyAccuracy(m)  // v0.9：預設 kCLLocationAccuracyHundredMeters / 50m（遠端設定 keepAlive）
    m.activityType = .otherNavigation
    m.pausesLocationUpdatesAutomatically = false
    m.showsBackgroundLocationIndicator = true
    manager = m
  }

  private func apply() {
    guard wanted, let m = manager else {
      publish()
      return
    }
    switch m.authorizationStatus {
    case .notDetermined:
      mode = "auth"
      m.requestWhenInUseAuthorization()
    case .authorizedWhenInUse, .authorizedAlways:
      // 需要 Info.plist UIBackgroundModes 含 location（不是 entitlement），否則這行會 assert
      m.allowsBackgroundLocationUpdates = true
      if #available(iOS 17.0, *), backgroundSession == nil {
        backgroundSession = CLBackgroundActivitySession()
      }
      m.startUpdatingLocation()
      if !(mode == "audio" && fallbackReason == "failed") {
        // 授權 OK（或剛從「被拒」改成允許）→ 定位保活，停掉音訊
        mode = "location"
        fallbackReason = nil
        locationError = nil
        audio.stop()
      }
    case .denied, .restricted:
      fallback("denied", "定位權限被拒（設定›熊貓倒數›位置 選「使用 App 期間」）")
    @unknown default:
      fallback("denied", "定位授權狀態未知")
    }
    publish()
  }

  private func fallback(_ reason: String, _ message: String) {
    guard wanted else { return }
    if reason == "denied" {
      manager?.stopUpdatingLocation()
      invalidateBackgroundSession()
    }
    mode = "audio"
    fallbackReason = reason
    locationError = message
    audio.start()
  }

  private func invalidateBackgroundSession() {
    if #available(iOS 17.0, *), let session = backgroundSession as? CLBackgroundActivitySession {
      session.invalidate()
    }
    backgroundSession = nil
  }

  private func publish() {
    let auth = manager.map { Self.authText($0.authorizationStatus) } ?? "unknown"
    let next = Published(
      wanted: wanted, mode: wanted ? mode : "none", auth: auth, fix: lastLocation?.timestamp, error: locationError,
      accuracy: "\(accuracyName)/\(distanceFilterM)m")
    lock.lock()
    published = next
    lock.unlock()
  }

  private static func authText(_ status: CLAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .authorizedWhenInUse: return "whenInUse"
    case .authorizedAlways: return "always"
    case .denied: return "denied"
    case .restricted: return "restricted"
    @unknown default: return "unknown"
    }
  }

  // MARK: CLLocationManagerDelegate（主執行緒）

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    onMain { self.apply() }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    onMain {
      if let last = locations.last { self.lastLocation = last }
      if self.wanted && self.mode == "audio" && self.fallbackReason == "failed" {
        // 定位恢復 → 回到定位保活、停備援音訊
        self.mode = "location"
        self.fallbackReason = nil
        self.locationError = nil
        self.audio.stop()
      }
      self.publish()
    }
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    let code = (error as? CLError)?.code
    onMain {
      if code == .locationUnknown { return }  // 暫時拿不到位置，系統會繼續試
      if code == .denied {
        self.fallback("denied", "定位權限被拒（設定›熊貓倒數›位置 選「使用 App 期間」）")
      } else {
        self.fallback("failed", "定位失敗：\(error.localizedDescription)")
      }
      self.publish()
    }
  }
}

// MARK: - 備援：背景音訊保活（靜音、可與其他 App 混音，不打斷 pandarider 提示音或使用者音樂）

final class AudioKeepAlive {
  struct Snapshot {
    let wanted: Bool
    let playing: Bool
    let interrupted: Bool
    let error: String?
  }

  private let q = DispatchQueue(label: "com.pandatimer.detector.keepalive")
  private let lock = NSLock()
  private var state = Snapshot(wanted: false, playing: false, interrupted: false, error: nil)
  // 只在 q 上存取
  private var player: AVAudioPlayer?
  private var wanted = false
  private var interrupted = false
  private var lastError: String?
  private var observers: [NSObjectProtocol] = []

  init() {
    let center = NotificationCenter.default
    observers.append(
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) {
        [weak self] note in
        let raw = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue
        let type = raw.flatMap { AVAudioSession.InterruptionType(rawValue: $0) }
        self?.q.async {
          guard let self = self else { return }
          if type == .began {
            self.interrupted = true
            self.publish()
          } else if type == .ended {
            // mixable session 不一定收得到 ended（Apple 論壇：不保證），所以看門狗/回前景也會補播
            self.interrupted = false
            self.activate()
          }
        }
      })
    observers.append(
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) {
        [weak self] _ in
        self?.q.async { self?.activateIfStopped() }
      })
    observers.append(
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) {
        [weak self] _ in
        self?.q.async {
          self?.player = nil
          self?.activate()
        }
      })
  }

  func snapshot() -> Snapshot {
    lock.lock()
    defer { lock.unlock() }
    return state
  }

  func start() {
    q.async {
      self.wanted = true
      self.activate()
    }
  }

  func stop() {
    q.async {
      let had = self.wanted || self.player != nil
      self.wanted = false
      self.interrupted = false
      self.player?.stop()
      self.player = nil
      if had {
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
      }
      self.publish()
    }
  }

  func ensurePlaying() {
    q.async { self.activateIfStopped() }
  }

  private func activateIfStopped() {
    guard wanted, player?.isPlaying != true else { return }
    activate()
  }

  private func activate() {
    guard wanted else {
      publish()
      return
    }
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
      try session.setActive(true)
      if player == nil {
        let p = try AVAudioPlayer(data: Self.silentWav())
        p.numberOfLoops = -1
        p.prepareToPlay()
        player = p
      }
      if player?.isPlaying != true, player?.play() != true {
        throw NSError(domain: "PandaKeepAlive", code: 1, userInfo: [NSLocalizedDescriptionKey: "play() 失敗"])
      }
      interrupted = false
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
    publish()
  }

  private func publish() {
    let snap = Snapshot(
      wanted: wanted, playing: player?.isPlaying == true, interrupted: interrupted, error: lastError)
    lock.lock()
    state = snap
    lock.unlock()
  }

  /// 1 秒、8kHz、16-bit 單聲道、全 0 樣本的 WAV（程式產生，不用額外音檔）
  static func silentWav(seconds: Double = 1, sampleRate: Int = 8000) -> Data {
    let samples = Int(Double(sampleRate) * seconds)
    let dataSize = samples * 2
    var d = Data()
    func ascii(_ s: String) { d.append(contentsOf: Array(s.utf8)) }
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    ascii("RIFF")
    u32(UInt32(36 + dataSize))
    ascii("WAVE")
    ascii("fmt ")
    u32(16)
    u16(1)  // PCM
    u16(1)  // mono
    u32(UInt32(sampleRate))
    u32(UInt32(sampleRate * 2))
    u16(2)
    u16(16)
    ascii("data")
    u32(UInt32(dataSize))
    d.append(Data(count: dataSize))
    return d
  }
}

// MARK: - v0.7 自動送達：從進行中鏡像結單（同 PandaSharedStore.finishOrder 的格式與鎖；pod 看不到主 App target 的型別）

// MARK: - v0.9 電量/溫度量測（telemetry batt/charging/thermal/lowPower）
// UIDevice 是主執行緒 API → 在主執行緒讀進快取（refresh），任何執行緒讀快取（fields）；ProcessInfo 執行緒安全，直接讀。

enum DevicePower {
  private static let lock = NSLock()
  private static var battery: (level: Int, charging: Bool)?

  static func refresh() {
    Task { @MainActor in
      let device = UIDevice.current
      if !device.isBatteryMonitoringEnabled { device.isBatteryMonitoringEnabled = true }
      let level = device.batteryLevel  // 0…1；未知 -1
      let state = device.batteryState
      let value: (level: Int, charging: Bool)? =
        level < 0 ? nil : (level: Int((level * 100).rounded()), charging: state == .charging || state == .full)
      DevicePower.lock.lock()
      DevicePower.battery = value
      DevicePower.lock.unlock()
    }
  }

  static func fields() -> [String: Any] {
    let info = ProcessInfo.processInfo
    var d: [String: Any] = ["thermal": info.thermalState.rawValue, "lowPower": info.isLowPowerModeEnabled]
    lock.lock()
    let b = battery
    lock.unlock()
    if let b = b {
      d["batt"] = b.level
      d["charging"] = b.charging
    }
    return d
  }
}

enum AutoDelivery {
  /// 手動結單時間（ms；PandaSharedStore.finishOrder 與 JS 結單〔syncActiveOrders 偵測到單被移除〕寫入）
  static let lastManualKey = "pandatimer.native.lastManualDoneAt.v1"
  /// 自動結單時間（ms；PandaSharedStore.finishOrder 看到 20 秒內有自動結單就不再結）
  static let lastAutoKey = "pandatimer.native.lastAutoDoneAt.v1"
  static let manualGraceSeconds: Double = 90

  struct Finished {
    let id: String
    let acceptedAt: Double
    let estimateMin: Int
    let activityId: String?
    let notifIds: [String]
  }

  enum Outcome {
    case finished(Finished)
    case skipped(String)
  }

  /// disabled / manualRecent / noActive / tooNew；否則結「接單超過 minOrderAgeSec 秒」裡**截止最早**的那張（v0.8；
  /// 同截止取較早接單），寫 done 事件（at＝實際送達時間 date；互斥時間用 receivedAt）
  /// v1.1 matchedId（delivered.seq 對到的單）：只結那張，不看 minOrderAgeSec/手動互斥；已不在進行中 → matchedGone（不退回挑別張）
  static func finish(
    settings: RemoteConfig.DeliverySettings, at date: Date, receivedAt: Date, matchedId: String? = nil
  ) -> Outcome {
    guard settings.enabled else { return .skipped("disabled") }
    let defaults = UserDefaults.standard
    objc_sync_enter(defaults)
    defer { objc_sync_exit(defaults) }
    let nowMs = (receivedAt.timeIntervalSince1970 * 1000).rounded()
    let atMs = (date.timeIntervalSince1970 * 1000).rounded()
    if let want = matchedId {
      var active = NativeSync.readArray(NativeSync.activeKey)
      guard let i = active.firstIndex(where: { ($0["id"] as? String) == want }) else { return .skipped("matchedGone") }
      return .finished(remove(at: i, from: &active, atMs: atMs, nowMs: nowMs))
    }
    if let manual = (defaults.object(forKey: lastManualKey) as? NSNumber)?.doubleValue,
       nowMs - manual < manualGraceSeconds * 1000
    {
      return .skipped("manualRecent")
    }
    var active = NativeSync.readArray(NativeSync.activeKey)
    if active.isEmpty { return .skipped("noActive") }
    var index: Int?
    var best = Double.greatestFiniteMagnitude
    var bestDeadline = Double.greatestFiniteMagnitude
    for (i, item) in active.enumerated() {
      guard item["id"] is String, let accepted = (item["acceptedAt"] as? NSNumber)?.doubleValue else { continue }
      if nowMs - accepted < Double(settings.minOrderAgeSec) * 1000 { continue }
      let estimate = (item["estimateMin"] as? NSNumber)?.doubleValue ?? 0
      let deadline = (item["deadline"] as? NSNumber)?.doubleValue ?? (accepted + estimate * 60_000)
      if deadline < bestDeadline || (deadline == bestDeadline && accepted < best) {
        bestDeadline = deadline
        best = accepted
        index = i
      }
    }
    guard let i = index else { return .skipped("tooNew") }
    return .finished(remove(at: i, from: &active, atMs: atMs, nowMs: nowMs))
  }

  /// 呼叫端持 objc_sync(UserDefaults.standard)：鏡像移除該單、寫 done 事件、記自動結單時間
  private static func remove(at i: Int, from active: inout [[String: Any]], atMs: Double, nowMs: Double) -> Finished {
    let item = active.remove(at: i)
    NativeSync.writeArray(active, NativeSync.activeKey)
    let accepted = (item["acceptedAt"] as? NSNumber)?.doubleValue ?? atMs
    let order = Finished(
      id: item["id"] as? String ?? "", acceptedAt: accepted,
      estimateMin: (item["estimateMin"] as? NSNumber)?.intValue ?? 0,
      activityId: item["activityId"] as? String, notifIds: (item["notifIds"] as? [String]) ?? [])
    var event: [String: Any] = ["type": "done", "at": max(atMs, accepted), "orderId": order.id]
    if let aid = order.activityId { event["activityId"] = aid }
    var events = NativeSync.readArray(NativeSync.eventsKey)
    events.append(event)
    NativeSync.writeArray(events, NativeSync.eventsKey)
    let defaults = UserDefaults.standard
    defaults.set(nowMs, forKey: lastAutoKey)
    return order
  }
}

/// 事件佇列有新東西 → Darwin「com.pandatimer.drain」（DetectorHub 收到就叫 JS drain）
enum NativeSyncDrain {
  static func post() {
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(DetectorHub.drainName as CFString), nil, nil,
      true)
  }
}

// MARK: - 通知（不用 timeSensitive/critical：需要 entitlement）

enum DetectorNotify {
  static func post(title: String, body: String, passive: Bool, userInfo: [String: Any]? = nil) async {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = nil
    content.interruptionLevel = passive ? .passive : .active
    if let info = userInfo { content.userInfo = info }
    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    try? await UNUserNotificationCenter.current().add(request)
  }

  /// extension 發的「偵測到新單」通知（userInfo pandatimer=detected）裡的偵測時間：
  /// 同分鐘數（v0.6 起再比對序號）、在 notAfter 之前 10 分鐘內的最新一則。找不到回 nil。v0.8 一併回傳 stacked
  static func detectedAt(minutes: Int, seq: Int, notAfter: Date) async -> (date: Date, stacked: Bool)? {
    let delivered = await UNUserNotificationCenter.current().deliveredNotifications()
    var best: Date?
    var bestStacked = false
    for notification in delivered {
      let info = notification.request.content.userInfo
      guard (info["pandatimer"] as? String) == "detected",
            (info["minutes"] as? NSNumber)?.intValue == minutes,
            (info["seq"] as? NSNumber).map({ $0.intValue == seq }) ?? true,
            let ms = (info["detectedAt"] as? NSNumber)?.doubleValue
      else { continue }
      let t = Date(timeIntervalSince1970: ms / 1000)
      guard t <= notAfter.addingTimeInterval(5), notAfter.timeIntervalSince(t) < 600 else { continue }
      if best.map({ t > $0 }) ?? true {
        best = t
        bestStacked = (info["stacked"] as? NSNumber)?.boolValue ?? false
      }
    }
    return best.map { (date: $0, stacked: bestStacked) }
  }
}

/// 截止前 3 分與截止各一則（文字與 src/notify.ts、native/intents 的 IntentReminders 相同）
enum DetectorReminders {
  static func schedule(deadline: Date, estimateMin: Int) async -> [String] {
    let center = UNUserNotificationCenter.current()
    let settings = await center.notificationSettings()
    switch settings.authorizationStatus {
    case .authorized, .provisional, .ephemeral:
      break
    default:
      return []
    }
    let plans: [(Date, String, String)] = [
      (deadline.addingTimeInterval(-3 * 60), "🐼 剩 3 分鐘", "預估 \(estimateMin) 分的單快到了，加油！"),
      (deadline, "🐼 已到預估時間", "預估 \(estimateMin) 分的單已到時，現在開始算超時"),
    ]
    var ids: [String] = []
    for (when, title, body) in plans {
      let interval = when.timeIntervalSinceNow
      if interval <= 1 { continue }
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      content.sound = .default
      let request = UNNotificationRequest(
        identifier: UUID().uuidString, content: content,
        trigger: UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false))
      do {
        try await center.add(request)
        ids.append(request.identifier)
      } catch {
        continue
      }
    }
    return ids
  }
}
