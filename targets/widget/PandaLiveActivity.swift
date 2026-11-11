import ActivityKit
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

struct PandaLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: PandaTimerAttributes.self) { context in
      LockScreenView(context: context)
        .activityBackgroundTint(Color.black.opacity(0.85))
        .activitySystemActionForegroundColor(Color.white)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Text("🐼 熊貓")
            .font(.headline)
            .foregroundStyle(Color.white)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text("預估 \(context.state.estimateMinutes) 分")
            .font(.headline)
            .foregroundStyle(Color.white)
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack(alignment: .firstTextBaseline) {
            Text(statusLabel(context))
              .font(.title3.bold())
              .foregroundStyle(statusColor(context))
            Spacer()
            Text(context.state.deadline, style: .timer)
              .font(.system(size: 36, weight: .bold, design: .rounded))
              .monospacedDigit()
              .multilineTextAlignment(.trailing)
              .foregroundStyle(statusColor(context))
          }
        }
      } compactLeading: {
        Text("🐼")
      } compactTrailing: {
        Text(context.state.deadline, style: .timer)
          .monospacedDigit()
          .multilineTextAlignment(.trailing)
          .frame(maxWidth: 64)
          .foregroundStyle(statusColor(context))
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
      }
      Spacer()
      Text(context.state.deadline, style: .timer)
        .font(.system(size: 40, weight: .bold, design: .rounded))
        .monospacedDigit()
        .multilineTextAlignment(.trailing)
        .frame(maxWidth: 140, alignment: .trailing)
        .foregroundStyle(statusColor(context))
    }
    .padding(16)
  }
}
