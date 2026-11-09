// nextmap stats in the Mac menu bar: live visits from Cloudflare Web Analytics in the title, and in the menu the
// audience (countries, referrers, devices, load time), what visitors do (the counts of shared/stats.js), and the
// free-tier quotas (Function requests today, R2 reads this month, Analytics Engine points today). Live visits refresh
// every minute, the rest every five. The icon turns amber at 70 % of a quota and red at 90 %, with a notification once
// a day per threshold; the same thresholds as `node scripts/stats.js check`.
// Uses wrangler's own login (~/Library/Preferences/.wrangler), refreshed with `wrangler whoami` when it has expired;
// CLOUDFLARE_API_TOKEN in the environment wins (the Analytics Engine SQL API may need it).
//   swiftc -O StatsBar.swift -o StatsBar   (see install.sh)
import Cocoa

let ACCOUNT = "4aebe04c04af9a5b7f6b8065bf446565"
let SITE = "85c9ff3f3dfb463aa56769a6ba2a4eca"            // Web Analytics site tag of nextmap.pages.dev
let BUCKET = "nextmap-data"
let DATASET = "nextmap_stats"
let FREE_REQUESTS = 100_000.0, FREE_POINTS = 100_000.0, FREE_R2_READS = 10_000_000.0
let WARN = 0.7, ALARM = 0.9
let WRANGLER = NSHomeDirectory() + "/Library/Preferences/.wrangler/config/default.toml"

func tomlValue(_ key: String) -> String? {
  guard let s = try? String(contentsOfFile: WRANGLER, encoding: .utf8) else { return nil }
  for line in s.split(separator: "\n") where line.hasPrefix(key + " ") {
    return line.split(separator: "\"", omittingEmptySubsequences: false).dropFirst().first.map(String.init)
  }
  return nil
}

func token() -> String? {
  if let t = ProcessInfo.processInfo.environment["CLOUDFLARE_API_TOKEN"], !t.isEmpty { return t }
  let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let exp = tomlValue("expiration_time").flatMap(iso.date), exp > Date().addingTimeInterval(60) { return tomlValue("oauth_token") }
  let p = Process()                                     // wrangler refreshes its token on any authenticated command
  p.executableURL = URL(fileURLWithPath: "/bin/zsh"); p.arguments = ["-lc", "npx --yes wrangler whoami >/dev/null 2>&1"]
  try? p.run(); p.waitUntilExit()
  return tomlValue("oauth_token")
}

// ------------------------------------------------------------ Cloudflare
func post(_ url: String, body: Data, json: Bool) -> [String: Any]? {
  guard let t = token() else { return nil }
  var req = URLRequest(url: URL(string: url)!)
  req.httpMethod = "POST"; req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
  if json { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
  req.httpBody = body
  var out: Data?; let done = DispatchSemaphore(value: 0)
  URLSession.shared.dataTask(with: req) { d, _, _ in out = d; done.signal() }.resume(); done.wait()
  guard let d = out, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
  return j
}
func gql(_ query: String) -> [String: Any]? {
  guard let body = try? JSONSerialization.data(withJSONObject: ["query": query]),
        let j = post("https://api.cloudflare.com/client/v4/graphql", body: body, json: true),
        let acc = ((j["data"] as? [String: Any])?["viewer"] as? [String: Any])?["accounts"] as? [[String: Any]] else { return nil }
  return acc.first
}
func sql(_ query: String) -> [[String: Any]] {
  guard let j = post("https://api.cloudflare.com/client/v4/accounts/\(ACCOUNT)/analytics_engine/sql", body: Data(query.utf8), json: false) else { return [] }
  return j["data"] as? [[String: Any]] ?? []
}

let isoF = ISO8601DateFormatter()
func since(_ seconds: Double) -> String { isoF.string(from: Date().addingTimeInterval(-seconds)) }
func dayStart() -> String {
  var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(identifier: "UTC")!
  return isoF.string(from: utc.startOfDay(for: Date()))
}
func monthStart() -> String {
  var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(identifier: "UTC")!
  let c = utc.dateComponents([.year, .month], from: Date())
  return isoF.string(from: utc.date(from: c)!)
}
func num(_ v: Any?) -> Double { (v as? NSNumber)?.doubleValue ?? 0 }
func sumOf(_ g: [String: Any]?, _ key: String) -> Double { num((g?["sum"] as? [String: Any])?[key]) }
func first(_ a: [String: Any], _ k: String) -> [String: Any]? { (a[k] as? [[String: Any]])?.first }
func dims(_ a: [String: Any], _ k: String, _ dim: String) -> [(String, Int)] {
  (a[k] as? [[String: Any]] ?? []).map { ((($0["dimensions"] as? [String: Any])?[dim] as? String) ?? "(none)", Int(sumOf($0, "visits"))) }
}

struct Live { var visits = 0, today = 0, todayViews = 0, week = 0 }
struct Detail {
  var countries: [(String, Int)] = [], referrers: [(String, Int)] = [], devices: [(String, Int)] = []
  var lcpP50 = 0.0, lcpP75 = 0.0
  var requests = 0.0, fnErrors = 0.0, r2Reads = 0.0, points = 0.0
  var usage: [(String, Int)] = [], usageVisits = 0, health: [(String, Int)] = [], usageError = false
}

func fetchLive() -> Live? {
  let rum = { (from: String) in "rumPageloadEventsAdaptiveGroups(limit:1,filter:{siteTag:\"\(SITE)\",datetime_geq:\"\(from)\"}){count sum{visits}}" }
  guard let a = gql("{viewer{accounts(filter:{accountTag:\"\(ACCOUNT)\"}){live:\(rum(since(1800))) today:\(rum(dayStart())) week:\(rum(since(7 * 86400)))}}}") else { return nil }
  return Live(visits: Int(sumOf(first(a, "live"), "visits")), today: Int(sumOf(first(a, "today"), "visits")),
              todayViews: Int(num(first(a, "today")?["count"])), week: Int(sumOf(first(a, "week"), "visits")))
}
func fetchDetail() -> Detail? {
  let top = { (dim: String) in "rumPageloadEventsAdaptiveGroups(limit:5,filter:{siteTag:\"\(SITE)\",datetime_geq:\"\(since(7 * 86400))\"},orderBy:[sum_visits_DESC]){sum{visits} dimensions{\(dim)}}" }
  guard let a = gql("{viewer{accounts(filter:{accountTag:\"\(ACCOUNT)\"}){countries:\(top("countryName")) referrers:\(top("refererHost")) devices:\(top("deviceType")) " +
    "perf:rumPerformanceEventsAdaptiveGroups(limit:1,filter:{siteTag:\"\(SITE)\",datetime_geq:\"\(since(7 * 86400))\"}){quantiles{largestContentfulPaintP50 largestContentfulPaintP75}} " +
    "fn:pagesFunctionsInvocationsAdaptiveGroups(limit:1,filter:{datetime_geq:\"\(dayStart())\"}){sum{requests errors}} " +
    "r2:r2OperationsAdaptiveGroups(limit:20,filter:{datetime_geq:\"\(monthStart())\",bucketName:\"\(BUCKET)\"}){sum{requests} dimensions{actionType}}}}}") else { return nil }
  var d = Detail()
  d.countries = dims(a, "countries", "countryName"); d.referrers = dims(a, "referrers", "refererHost"); d.devices = dims(a, "devices", "deviceType")
  let q = first(a, "perf")?["quantiles"] as? [String: Any]
  d.lcpP50 = num(q?["largestContentfulPaintP50"]); d.lcpP75 = num(q?["largestContentfulPaintP75"])
  d.requests = sumOf(first(a, "fn"), "requests"); d.fnErrors = sumOf(first(a, "fn"), "errors")
  for op in a["r2"] as? [[String: Any]] ?? [] {
    let name = ((op["dimensions"] as? [String: Any])?["actionType"] as? String) ?? ""
    let write = ["Put", "Copy", "Delete", "CreateMultipart", "UploadPart", "CompleteMultipart", "AbortMultipart"].contains { name.hasPrefix($0) }
    if !write { d.r2Reads += sumOf(op, "requests") }
  }
  // usage counts and up/ health from Analytics Engine; empty when the token cannot read the SQL API
  let day = String(dayStart().dropLast()).replacingOccurrences(of: "T", with: " ")
  let use = sql("SELECT index1 AS event, blob1 AS value, SUM(_sample_interval * double1) AS n FROM \(DATASET) WHERE timestamp > NOW() - INTERVAL '7' DAY AND index1 != 'up' GROUP BY event, value ORDER BY event, n DESC")
  d.usageError = use.isEmpty
  for r in use {
    let e = (r["event"] as? String) ?? "", v = (r["value"] as? String) ?? "", n = Int(num(r["n"]))
    if e == "visit" { d.usageVisits += n }
    d.usage.append(("\(e):\(v)", n))
  }
  for r in sql("SELECT blob1 AS kind, blob2 AS outcome, SUM(_sample_interval) AS n FROM \(DATASET) WHERE timestamp > NOW() - INTERVAL '7' DAY AND index1 = 'up' GROUP BY kind, outcome ORDER BY kind, n DESC") {
    d.health.append(("\((r["kind"] as? String) ?? "") \((r["outcome"] as? String) ?? "")", Int(num(r["n"]))))
  }
  d.points = num(sql("SELECT SUM(_sample_interval) AS n FROM \(DATASET) WHERE timestamp >= toDateTime('\(day)')").first?["n"])
  return d
}

// ------------------------------------------------------------ the menu
class App: NSObject, NSApplicationDelegate {
  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  let menu = NSMenu()
  var lines: [NSMenuItem] = []
  let audience = NSMenu(), usage = NSMenu(), quotas = NSMenu()
  var detail: Detail? = nil, lastLive: Live? = nil, level = 0, notified: [String: String] = [:]

  func applicationDidFinishLaunching(_ n: Notification) {
    item.button?.title = "🗺 …"
    for _ in 0..<4 { let m = NSMenuItem(title: "", action: nil, keyEquivalent: ""); lines.append(m); menu.addItem(m) }
    menu.addItem(.separator())
    for (title, sub) in [("Audience, 7 days", audience), ("What visitors do, 7 days", usage), ("Quotas", quotas)] {
      let m = NSMenuItem(title: title, action: nil, keyEquivalent: ""); m.submenu = sub; menu.addItem(m)
    }
    menu.addItem(.separator())
    menu.addItem(withTitle: "Open Web Analytics", action: #selector(openDash), keyEquivalent: "d").target = self
    menu.addItem(withTitle: "Refresh now", action: #selector(refreshAll), keyEquivalent: "r").target = self
    menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    item.menu = menu
    refreshAll()
    Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in self.refreshLive() }
    Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in self.refreshDetail() }
  }

  @objc func refreshAll() { refreshLive(); refreshDetail() }
  func refreshLive() { DispatchQueue.global().async { let s = fetchLive(); DispatchQueue.main.async { self.showLive(s) } } }
  func refreshDetail() { DispatchQueue.global().async { let d = fetchDetail(); DispatchQueue.main.async { self.showDetail(d) } } }

  func title(_ live: String) {
    let color: NSColor? = level >= 2 ? .systemRed : level == 1 ? .systemOrange : nil
    let text = "🗺 \(live)" + (level >= 2 ? " ‼︎" : level == 1 ? " ⚠︎" : "")
    if let c = color { item.button?.attributedTitle = NSAttributedString(string: text, attributes: [.foregroundColor: c]) }
    else { item.button?.title = text }
  }
  func showLive(_ s: Live?) {
    let time = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .short)
    guard let s = s else { title("?"); lines[0].title = "Could not reach Cloudflare (\(time))"; return }
    lastLive = s
    title("\(s.visits)")
    lines[0].title = "Visits, last 30 min: \(s.visits)"
    lines[1].title = "Visits today (UTC): \(s.today)  ·  \(s.todayViews) page views"
    lines[2].title = "Visits, last 7 days: \(s.week)"
    lines[3].title = "Updated \(time)"
  }
  func fill(_ m: NSMenu, _ rows: [String]) {
    m.removeAllItems()
    for r in rows { m.addItem(withTitle: r, action: nil, keyEquivalent: "") }
  }
  func pct(_ x: Double) -> String { String(format: "%.1f%%", x * 100) }
  func showDetail(_ d: Detail?) {
    guard let d = d else { fill(quotas, ["Could not reach Cloudflare"]); return }
    detail = d
    var aud: [String] = ["Countries"] + d.countries.map { "   \($0.0): \($0.1)" }
    aud += ["Referrers"] + d.referrers.map { "   \($0.0): \($0.1)" }
    aud += ["Devices"] + d.devices.map { "   \($0.0): \($0.1)" }
    aud += [String(format: "Load time (LCP): %.0f ms median, %.0f ms p75", d.lcpP50, d.lcpP75)]
    fill(audience, aud)
    if d.usageError { fill(usage, ["No usage counts yet (or the token cannot read Analytics Engine; set CLOUDFLARE_API_TOKEN)"]) }
    else {
      var rows = ["\(d.usageVisits) counted visits"]
      for (k, n) in d.usage where !k.hasPrefix("visit:") {
        rows.append(d.usageVisits > 0 ? "   \(k): \(n)  (\(pct(Double(n) / Double(d.usageVisits))) of visits)" : "   \(k): \(n)")
      }
      if !d.health.isEmpty { rows.append("up/ Function, past the edge cache"); rows += d.health.map { "   \($0.0): \($0.1)" } }
      fill(usage, rows)
    }
    let fnShare = d.requests / FREE_REQUESTS, r2Share = d.r2Reads / FREE_R2_READS, ptShare = d.points / FREE_POINTS
    fill(quotas, [
      String(format: "Function requests today: %.0f of 100,000 free (%@)  ·  %.0f errors", d.requests, pct(fnShare), d.fnErrors),
      String(format: "R2 reads this month: %.0f of 10,000,000 free (%@)", d.r2Reads, pct(r2Share)),
      String(format: "Analytics Engine points today: %.0f of 100,000 free (%@)", d.points, pct(ptShare)),
    ])
    // the worst quota decides the colour; the early warning (70 % before 18:00 UTC) and the alarm notify once a day
    let hour = Calendar(identifier: .gregorian).dateComponents(in: TimeZone(identifier: "UTC")!, from: Date()).hour ?? 0
    let shares = [("Function requests today", fnShare, hour < 18), ("R2 reads this month", r2Share, true), ("Analytics Engine points today", ptShare, true)]
    level = 0
    for (name, share, early) in shares {
      let l = share >= ALARM ? 2 : (share >= WARN && early) ? 1 : 0
      level = max(level, l)
      if l > 0 { notify(name, "\(name) at \(pct(share)) of the free tier") }
    }
    if let l = lastLive { title("\(l.visits)") }
  }
  func notify(_ key: String, _ text: String) {
    let day = String(dayStart().prefix(10))
    if notified[key] == day { return }
    notified[key] = day
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = ["-e", "display notification \"\(text)\" with title \"nextmap\""]
    try? p.run()
  }

  @objc func openDash() {
    NSWorkspace.shared.open(URL(string: "https://dash.cloudflare.com/\(ACCOUNT)/web-analytics/overview?siteTag~in=\(SITE)")!)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)                    // menu bar only, no Dock icon
let delegate = App(); app.delegate = delegate
app.run()
