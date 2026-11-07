// nextmap stats in the Mac menu bar: visits from Cloudflare Web Analytics and today's Function requests against
// the free 100k a day, refreshed every minute. Uses wrangler's own login (~/Library/Preferences/.wrangler), and
// runs `wrangler whoami` to refresh it when it has expired.
//   swiftc -O StatsBar.swift -o StatsBar   (see install.sh)
import Cocoa

let ACCOUNT = "4aebe04c04af9a5b7f6b8065bf446565"
let SITE = "85c9ff3f3dfb463aa56769a6ba2a4eca"            // Web Analytics site tag of nextmap.pages.dev
let FREE_REQUESTS = 100_000.0
let WRANGLER = NSHomeDirectory() + "/Library/Preferences/.wrangler/config/default.toml"

func tomlValue(_ key: String) -> String? {
  guard let s = try? String(contentsOfFile: WRANGLER, encoding: .utf8) else { return nil }
  for line in s.split(separator: "\n") where line.hasPrefix(key + " ") {
    return line.split(separator: "\"", omittingEmptySubsequences: false).dropFirst().first.map(String.init)
  }
  return nil
}

func token() -> String? {
  let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let exp = tomlValue("expiration_time").flatMap(iso.date), exp > Date().addingTimeInterval(60) { return tomlValue("oauth_token") }
  let p = Process()                                     // wrangler refreshes its token on any authenticated command
  p.executableURL = URL(fileURLWithPath: "/bin/zsh"); p.arguments = ["-lc", "npx --yes wrangler whoami >/dev/null 2>&1"]
  try? p.run(); p.waitUntilExit()
  return tomlValue("oauth_token")
}

struct Stats { var live = 0, today = 0, todayViews = 0, week = 0, requests = 0 }

func fetch() -> Stats? {
  guard let t = token() else { return nil }
  let f = ISO8601DateFormatter(), now = Date()
  var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(identifier: "UTC")!
  let day = f.string(from: utc.startOfDay(for: now)), live = f.string(from: now.addingTimeInterval(-30 * 60))
  let week = f.string(from: now.addingTimeInterval(-7 * 86400))
  let rum = { (from: String) in "rumPageloadEventsAdaptiveGroups(limit:1,filter:{siteTag:\"\(SITE)\",datetime_geq:\"\(from)\"}){count sum{visits}}" }
  let q = "{viewer{accounts(filter:{accountTag:\"\(ACCOUNT)\"}){live:\(rum(live)) today:\(rum(day)) week:\(rum(week)) " +
    "fn:pagesFunctionsInvocationsAdaptiveGroups(limit:1,filter:{datetime_geq:\"\(day)\"}){sum{requests}}}}}"
  var req = URLRequest(url: URL(string: "https://api.cloudflare.com/client/v4/graphql")!)
  req.httpMethod = "POST"; req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
  req.setValue("application/json", forHTTPHeaderField: "Content-Type")
  req.httpBody = try? JSONSerialization.data(withJSONObject: ["query": q])
  var out: Data?; let done = DispatchSemaphore(value: 0)
  URLSession.shared.dataTask(with: req) { d, _, _ in out = d; done.signal() }.resume(); done.wait()
  guard let d = out, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
        let acc = ((j["data"] as? [String: Any])?["viewer"] as? [String: Any])?["accounts"] as? [[String: Any]],
        let a = acc.first else { return nil }
  let first = { (k: String) in (a[k] as? [[String: Any]])?.first }
  let visits = { (k: String) in (first(k)?["sum"] as? [String: Any])?["visits"] as? Int ?? 0 }
  return Stats(live: visits("live"), today: visits("today"), todayViews: first("today")?["count"] as? Int ?? 0,
               week: visits("week"), requests: (first("fn")?["sum"] as? [String: Any])?["requests"] as? Int ?? 0)
}

class App: NSObject, NSApplicationDelegate {
  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  let menu = NSMenu()
  var lines: [NSMenuItem] = []

  func applicationDidFinishLaunching(_ n: Notification) {
    item.button?.title = "🗺 …"
    for _ in 0..<5 { let m = NSMenuItem(title: "", action: nil, keyEquivalent: ""); lines.append(m); menu.addItem(m) }
    menu.addItem(.separator())
    menu.addItem(withTitle: "Open Web Analytics", action: #selector(openDash), keyEquivalent: "d").target = self
    menu.addItem(withTitle: "Refresh now", action: #selector(refresh), keyEquivalent: "r").target = self
    menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    item.menu = menu
    refresh()
    Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in self.refresh() }
  }

  @objc func refresh() {
    DispatchQueue.global().async {
      let s = fetch()
      DispatchQueue.main.async { self.show(s) }
    }
  }

  func show(_ s: Stats?) {
    let time = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .short)
    guard let s = s else { item.button?.title = "🗺 ?"; lines[0].title = "Could not reach Cloudflare (\(time))"; return }
    let pct = Double(s.requests) / FREE_REQUESTS * 100
    item.button?.title = "🗺 \(s.live)" + (pct >= 80 ? " ⚠︎" : "")
    lines[0].title = "Visits, last 30 min: \(s.live)"
    lines[1].title = "Visits today (UTC): \(s.today)  ·  \(s.todayViews) page views"
    lines[2].title = "Visits, last 7 days: \(s.week)"
    lines[3].title = String(format: "Tile requests today: %d of 100,000 free (%.1f%%)", s.requests, pct)
    lines[4].title = "Updated \(time)"
  }

  @objc func openDash() {
    NSWorkspace.shared.open(URL(string: "https://dash.cloudflare.com/\(ACCOUNT)/web-analytics/overview?siteTag~in=\(SITE)")!)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)                    // menu bar only, no Dock icon
let delegate = App(); app.delegate = delegate
app.run()
