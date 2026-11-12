import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct PandaWidgetBundle: WidgetBundle {
  var body: some Widget {
    PandaLiveActivity()
  }
}

private let pandaPink = Color(red: 215 / 255, green: 15 / 255, blue: 100 / 255)

/// 截止前顯示「剩餘」；過了 staleDate(=截止時間) 系統會重繪，isStale = true → 「已超時」。
/// Text(deadline, style: .timer) 過了截止會自動往上數，代表超時多久。
private func statusLabel(_ context: ActivityViewContext<PandaTimerAttributes>) -> String {
  context.isStale ? "已超時" : "剩餘"
}

private func statusColor(_ context: ActivityViewContext<PandaTimerAttributes>) -> Color {
  context.isStale ? Color.red : Color.orange
}

/// v0.3 螢幕廣播偵測：mode == "standby"（偵測中）或 "stopped"（偵測已停止）時顯示偵測卡；其餘（nil/"countdown"）照舊倒數
private func isDetectorCard(_ state: PandaTimerAttributes.ContentState) -> Bool {
  state.mode == "standby" || state.mode == "stopped"
}

private func detectorTitle(_ state: PandaTimerAttributes.ContentState) -> String {
  state.mode == "stopped" ? "⏹ 偵測已停止" : "🐼 偵測中"
}

struct PandaLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: PandaTimerAttributes.self) { context in
      LockScreenView(context: context)
        .activityBackgroundTint(Color.black.opacity(0.85))
        .activitySystemActionForegroundColor(Color.white)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Text(isDetectorCard(context.state) ? detectorTitle(context.state) : "🐼 熊貓")
            .font(.headline)
            .foregroundStyle(Color.white)
        }
        DynamicIslandExpandedRegion(.trailing) {
          if isDetectorCard(context.state) {
            HeartbeatText(state: context.state)
              .font(.headline)
              .foregroundStyle(Color.white)
          } else {
            Text("預估 \(context.state.estimateMinutes) 分")
              .font(.headline)
              .foregroundStyle(Color.white)
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          if isDetectorCard(context.state) {
            HStack(alignment: .center) {
              DetectorDetail(state: context.state)
              if context.state.mode == "standby" {
                StartCountdownButton()
              }
            }
          } else {
            VStack(alignment: .leading, spacing: 2) {
              HStack(alignment: .center) {
                Text(statusLabel(context))
                  .font(.title3.bold())
                  .foregroundStyle(statusColor(context))
                Spacer()
                Text(context.state.deadline, style: .timer)
                  .font(.system(size: 36, weight: .bold, design: .rounded))
                  .monospacedDigit()
                  .multilineTextAlignment(.trailing)
                  .foregroundStyle(statusColor(context))
                DeliverButton(activityId: context.activityID)
              }
              OthersText(state: context.state)
            }
          }
        }
      } compactLeading: {
        Text("🐼")
      } compactTrailing: {
        if isDetectorCard(context.state) {
          Text(context.state.mode == "stopped" ? "停止" : "偵測")
            .foregroundStyle(context.state.mode == "stopped" ? Color.gray : Color.green)
        } else {
          Text(context.state.deadline, style: .timer)
            .monospacedDigit()
            .multilineTextAlignment(.trailing)
            .frame(maxWidth: 64)
            .foregroundStyle(statusColor(context))
        }
      } minimal: {
        Text("🐼")
      }
      .keylineTint(pandaPink)
    }
  }
}

struct LockScreenView: View {
  let context: ActivityViewContext<PandaTimerAttributes>

  var body: some View {
    if isDetectorCard(context.state) {
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Text(detectorTitle(context.state))
            .font(.headline)
            .foregroundStyle(context.state.mode == "stopped" ? Color.gray : Color.green)
          Spacer()
          HeartbeatText(state: context.state)
            .font(.headline)
            .foregroundStyle(Color.white)
        }
        HStack(alignment: .center) {
          DetectorDetail(state: context.state)
          if context.state.mode == "standby" {
            StartCountdownButton()
          }
        }
      }
      .padding(16)
    } else {
      countdownBody
    }
  }

  private var countdownBody: some View {
    HStack(alignment: .center, spacing: 12) {
      Text("🐼")
        .font(.system(size: 40))
      VStack(alignment: .leading, spacing: 4) {
        Text(statusLabel(context))
          .font(.headline)
          .foregroundStyle(statusColor(context))
        Text("預估 \(context.state.estimateMinutes) 分・截止 \(context.state.deadline, style: .time)")
          .font(.subheadline)
          .foregroundStyle(Color.white.opacity(0.8))
        OthersText(state: context.state)
        if let diag = context.state.diag {
          Text(diag)
            .font(.caption2)
            .foregroundStyle(Color.white.opacity(0.6))
            .lineLimit(1)
        }
      }
      Spacer()
      Text(context.state.deadline, style: .timer)
        .font(.system(size: 34, weight: .bold, design: .rounded))
        .monospacedDigit()
        .multilineTextAlignment(.trailing)
        .frame(maxWidth: 120, alignment: .trailing)
        .foregroundStyle(statusColor(context))
      DeliverButton(activityId: context.activityID)
    }
    .padding(16)
  }
}

/// iOS 17 互動式 Live Activity：按下由系統在 App 程序背景執行 DeliverActivityIntent（結束這一張卡片的單）
struct DeliverButton: View {
  let activityId: String

  var body: some View {
    Button(intent: DeliverActivityIntent(activityId: activityId)) {
      Text("送達")
        .font(.headline.bold())
        .foregroundStyle(Color.white)
        .padding(.horizontal, 6)
    }
    .buttonStyle(.borderedProminent)
    .tint(Color.green)
  }
}

/// v0.5 一鍵備援：偵測卡（standby）上的「開始倒數」。背景更新被系統擋、動態島還停在「偵測中」時按這顆，
/// 由系統在 App 程序執行 StartDetectedCountdownIntent，把卡改成最近一次自動偵測那單的倒數。
struct StartCountdownButton: View {
  var body: some View {
    Button(intent: StartDetectedCountdownIntent()) {
      Text("開始倒數")
        .font(.headline.bold())
        .foregroundStyle(Color.white)
        .padding(.horizontal, 4)
    }
    .buttonStyle(.borderedProminent)
    .tint(pandaPink)
  }
}

/// v0.6 多單：卡上倒數的是最早截止那單，其餘列在這行（「另 2 單：18:42、18:55 截止」）；送達後自動切到下一單。
struct OthersText: View {
  let state: PandaTimerAttributes.ContentState

  var body: some View {
    if let others = state.others, !others.isEmpty {
      Text(others)
        .font(.caption.bold())
        .foregroundStyle(Color.yellow)
        .lineLimit(1)
    }
  }
}

/// 偵測卡的心跳時間（時:分:秒）。v0.9 起心跳的卡片 update 有節流（診斷字沒實質變化時最多每 app.cardRefreshSeconds＝5 分更新一次），
/// 時間舊幾分鐘是正常的；偵測停了由 App 看門狗在 150 秒內把卡片改成「⚠️ N 分鐘沒收到偵測心跳」。
struct HeartbeatText: View {
  let state: PandaTimerAttributes.ContentState

  var body: some View {
    if let beat = state.heartbeat {
      Text("心跳 \(beat, format: .dateTime.hour().minute().second())")
        .monospacedDigit()
    } else {
      Text("等待廣播…")
    }
  }
}

/// 偵測卡下方：距離上次心跳多久（系統自動更新）＋診斷小字
struct DetectorDetail: View {
  let state: PandaTimerAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      if let beat = state.heartbeat {
        Text("上次回報：\(beat, style: .relative)前")
          .font(.caption)
          .foregroundStyle(Color.white.opacity(0.8))
      }
      Text(state.diag ?? "按 App 的「開始偵測」後，在跳出的視窗按「開始直播」")
        .font(.caption2)
        .foregroundStyle(Color.white.opacity(0.6))
        .lineLimit(2)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}
